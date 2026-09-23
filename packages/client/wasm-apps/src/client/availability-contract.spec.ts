/// <reference types="node" />
/**
 * **判词集合的跨端对拍**（服务端 `read.go` + `publish.go` ↔ 本包 `availability-contract.ts`）。
 *
 * ## 这条闸要拦的缺陷类
 *
 * "两端各钉自己的字面量"：`availability` 的 `reason` 由服务端定义，客户端为在填表阶段
 * 给出结论必须持一份镜像 —— 两份规格之间**没有任何东西保证它们相等**，除非有人读对方
 * 的源码来对拍。R3-A 的 A-4 就是实例：服务端修好终态判据后新增了 `frozen` / `retired`
 * 两个判词，客户端联合类型里没有，于是 fail-closed 解析器（`parseAvailability`）把它们
 * 一律归成 `null` ⇒ 界面显示"暂时无法确认"，用户**拿不到新判词的文案**，也（在补上
 * `blocksSubmit` 之前）不会在填表阶段被拦下 —— 白传一个 32 MiB 的包才拿到 403/404。
 *
 * ## 为什么必须读源码文本
 *
 * 客户端不能 import Go 包，也不该为一条契约断言引入代码生成。抠法只依赖"判词写成
 * 字符串字面量"这一个稳定形状：
 *
 *  - `read.go` 的 `func (h *Handlers) availability(` —— gin.H 字面量键 `"reason": "x"`、
 *    赋值 `out["reason"] = "x"`，以及**委派** `out["reason"] = blocked.Reason`；
 *  - `publish.go` 的 `func publishBlockOf(` —— 委派目标的两个终态判词 `Reason: "x"`。
 *
 * **抠不出来就 throw**（函数改名/搬走/委派被拆掉）：对拍失效必须是红的，不是 skip
 * —— 这条纪律在 `appcfg-contract.spec.ts` 已经付过一次学费（skipIf 让整道闸静默）。
 *
 * ## 判据的强度 = **写入点计数**，不只是"抠出来的集合相等"
 *
 * 第三轮独立复审（`temp/verify-wasm-tail/VERIFY.md` §5 F1）实测出两类**静默漏判**：
 * 服务端把新终态写成**常量**（`Reason: publishReasonSuspended`）或写成**大写/非常规**
 * 字面量（`out["reason"] = "nameBlocked"`，抠取用的字符类是 `[a-z_]+`）时，抠出来的
 * 集合与客户端镜像**仍然相等** ⇒ 全绿。这正是本闸存在的理由（服务端加了判词、客户端
 * 不跟）却恰好漏掉的情形（后果与 A-4 同形：用户拿不到文案、也不被拦下提交）。
 *
 * 因此判据升级为"**每一个写入点都必须被认出来**"，任一处认不出即 throw：
 *
 *  - `publishBlockOf`：`Reason:` 字段写入点数 == 抠出的字面量数；整个 `publish.go` 的
 *    `Reason:` 写入点必须都在 `publishBlockOf` 里；每一次 `return` 都必须是
 *    `return nil` 或 `return &publishBlock{` 字面量（防"终态在别的函数/别的文件里构造"）；
 *  - `availability()`：`"reason":` 键写入点数 == 字面量键数；`out["reason"] =` 赋值
 *    写入点数 == 字面量赋值数 + 委派数（`blocked.Reason`）。
 *
 * 红信息带**文件:行 + 原文 + 缺哪个形态**，照抄即可（`renderWritePoints`）。
 *
 * ## 判据（"只改一侧必红"两侧都成立）
 *
 *  1. 服务端集合 == 客户端集合（{@link APP_AVAILABILITY_REASONS}）⇒ 服务端加一个判词红；
 *  2. 客户端集合 == 文案表键集合（`Record<AppAvailabilityReason, …>` 另由 tsc 兜底）
 *     ⇒ 客户端少一个判词红；
 *  3. 文案表里每个键在 zh / en 字典里都有非空文案 ⇒ 漏翻译红；
 *  4. 反向：**未登记**的判词必须走 fail-closed（`parseAvailability` → `null`，
 *     `checkAppIdAvailability` → `UNEXPECTED_RESPONSE`），绝不落成"可用"。
 *
 * ## `blocksSubmit` 静态表与服务端 `can_publish` 的**等价前提**（复审 F4）
 *
 * 提交闸用的是本包的**静态表**（`AvailabilityReasonCopy.blocksSubmit`），**不是**服务端
 * 响应里的 `can_publish` 字段（改成读响应字段是行为变更：需要在提交那一刻真的再问一次
 * 服务端，查重失败时的语义也要重定）。两者当前**等价**，但等价的前提是一条**组合约束**：
 * 服务端只把 `available` / `yours` 两个判词与 `can_publish=true` 放在一起，其余四个
 * （`taken` / `invalid` / `frozen` / `retired`）恒为 `false`。这条约束由下面的
 * {@link availabilityCanPublishShape} **从服务端源码派生**并逐项钉住 ——
 * **今天任一侧变化都会让等价失效**：服务端改语义（例如给管理员接管加一个
 * `can_publish=true` 的非 `yours` 判词）⇒ 映射用例红；客户端改 `blocksSubmit` ⇒
 * 「拦下提交的判词」用例红。届时要做的不是"把闸调绿"，而是拍板提交闸改读
 * `can_publish` 还是重算静态表。
 *
 * 另：**不再钉**"`out["can_publish"] = true` 恰好出现 2 次"这种实现形状（复审 F8：
 * 等价重构会假红）。取而代之的是"每个 `can_publish` 写入点都必须是 `true` / `false`
 * 字面量形态"+"置 true 的写入点所属判词必须恰好是 {available, yours}"。
 *
 * ---- 变异验证（逐个实跑，见报告） ----
 *   - 服务端多一个未登记的判词（`publishBlockOf` 里加第三态 `Reason: "suspended"`）
 *     ⇒ 第 1 组红；
 *   - 服务端把新终态写成**常量**（`Reason: publishReasonSuspended`）⇒ 写入点计数红
 *     （这是复审 F1 的形态 1：旧判据下**全绿**）；
 *   - 服务端写 `out["reason"] = "nameBlocked"`（大写，抠不到）⇒ 写入点计数红
 *     （复审 F1 的形态 2：旧判据下**全绿**）；
 *   - 客户端映射漏一个已登记判词（从 `APP_AVAILABILITY_REASONS` 删掉 `retired`）
 *     ⇒ 第 1、2 组红（且 tsc 也会红）；
 *   - 未知判词走成"可用"（把 `isAvailabilityReason` 改成恒真）⇒ 第 4 组红。
 *
 * @module @picoaide/dsh-wasm-apps/client/availability-contract.spec
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  APP_AVAILABILITY_REASONS,
  AVAILABILITY_REASON_COPY,
  isAvailabilityReason,
  type AppAvailabilityReason,
} from './availability-contract.ts'
import { checkAppIdAvailability, parseAvailability } from './publish-app.ts'
import { en, zh } from './locales.ts'

/** 仓库根：从本文件（`packages/client/wasm-apps/src/client/`）往上走四级。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

/** 服务端两个真源的仓库内路径（**路径本身也是契约**：搬走了对拍必须红）。 */
export const READ_GO_REPO_PATH = 'server/internal/wasmapp/api/read.go'
export const PUBLISH_GO_REPO_PATH = 'server/internal/wasmapp/api/publish.go'

/**
 * 读仓库内的服务端文件。**读不到就抛**（不返回 null、不 skip）：
 * 这道闸的全部价值就在于"真源在不在"，缺席必须是红的。
 * @param relative - 仓库内相对路径。
 * @returns 文件全文。
 */
function readRepoFile(relative: string): string {
  try {
    return readFileSync(join(REPO_ROOT, relative), 'utf8')
  } catch (cause) {
    throw new Error(`${relative} 读不到（${cause instanceof Error ? cause.message : String(cause)}）：跨端对拍的真源缺席，必须有人看一眼`)
  }
}

/**
 * 第 `index` 个字符所在的 1-based 行号。
 *
 * 红信息要能**照抄**（点名文件:行 + 原文），所以抠出来的每个写入点都必须能换回真实行号。
 * @param source - 全文。
 * @param index - 字符偏移。
 * @returns 1-based 行号。
 */
function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1
  }
  return line
}

/**
 * 行注释擦除：`// …` 换成**等长空格**。
 *
 * 用等长空格而不是删除：偏移量必须保持不变，否则 `lineAt` 报出的行号会整体位移、
 * 红信息就没法照抄了（注释里出现的 `"reason"` 例子也不该被当成真取值）。
 * @param source - 全文。
 * @returns 同样长度、注释位置被空格覆盖的文本。
 */
export function blankLineComments(source: string): string {
  return source.replace(/\/\/[^\n]*/gu, comment => ' '.repeat(comment.length))
}

/** 一段 Go 函数体：文本 + 它在**全文**里的起始偏移。 */
export interface GoFuncSlice {
  /** 从签名行到下一个行首 `func` 之间的文本。 */
  body: string
  /** `body` 在全文里的起始偏移（红信息据此报真实行号）。 */
  start: number
}

/**
 * 取一个 Go 函数（或方法）的切片。
 *
 * 只做 `\nfunc ` 边界切分 —— 与本仓 `appcfg-contract.spec.ts` 同款抠法：不解析 Go，
 * 只依赖"函数之间以行首 func 分隔"这一稳定形状。
 * @param source - Go 源文件全文（通常是 {@link blankLineComments} 之后的结果）。
 * @param signature - 函数签名前缀（如 `func (h *Handlers) availability(`）。
 * @returns 切片；找不到签名时返回 `null`（调用方据此 throw）。
 */
export function goFuncSlice(source: string, signature: string): GoFuncSlice | null {
  const start = source.indexOf(signature)
  if (start < 0) return null
  const nextFunc = source.indexOf('\nfunc ', start)
  return { body: source.slice(start, nextFunc < 0 ? undefined : nextFunc), start }
}

/**
 * 取一个 Go 函数（或方法）的函数体文本。
 * @param source - Go 源文件全文。
 * @param signature - 函数签名前缀（如 `func (h *Handlers) availability(`）。
 * @returns 函数体文本（含签名行）；找不到时返回空串。
 */
export function goFuncBody(source: string, signature: string): string {
  return goFuncSlice(source, signature)?.body ?? ''
}

/** 一次写入点在全文里的位置与原文（行号 + 原文都能直接照抄）。 */
export interface WritePoint {
  /** 相对全文的起始偏移。 */
  index: number
  /** 1-based 行号。 */
  line: number
  /** 写入点原文（截到行尾、去掉首尾空白）。 */
  raw: string
}

/**
 * 在函数体里找**全部**写入点（松匹配：只认"写到了这个字段"，不认值形态）。
 * @param source - 全文（用于算行号与原文）。
 * @param slice - 函数切片。
 * @param pattern - 必须带 `g` 标志的松匹配正则。
 * @returns 写入点列表（按原文顺序）。
 */
function findWritePoints(source: string, slice: GoFuncSlice, pattern: RegExp): WritePoint[] {
  const points: WritePoint[] = []
  for (const match of slice.body.matchAll(pattern)) {
    const index = slice.start + match.index
    const end = source.indexOf('\n', index)
    points.push({ index, line: lineAt(source, index), raw: source.slice(index, end < 0 ? undefined : end).trim() })
  }
  return points
}

/** 把一个写入点列表渲染成可照抄的清单（`文件:行 原文`）。 */
function renderWritePoints(path: string, points: readonly WritePoint[]): string {
  return points.map(point => `  - ${path}:${point.line}  ${point.raw}`).join('\n')
}

/** `availability()` 里的判词写入点。 */
export interface ReasonWritePoint extends WritePoint {
  /** 写入的判词字面量；**委派**（`out["reason"] = blocked.Reason`）时为 `null`。 */
  literal: string | null
  /** 书写形态：`gin.H` 键 / `out[...] =` 赋值。 */
  form: 'key' | 'assign'
}

/** `read.go` 的 availability 里抠出来的判词形状（含**写入点计数**）。 */
export interface AvailabilitySourceReasons {
  /** 直接写死在 availability 里的判词（gin.H 字面量键 + `out["reason"] = "x"`）。 */
  literals: string[]
  /** 是否把终态判词委派给 `publishBlockOf`（`out["reason"] = blocked.Reason`）。 */
  delegatesToPublishBlock: boolean
  /** 全部判词写入点（键 + 赋值，按原文顺序）。 */
  writePoints: ReasonWritePoint[]
  /** 认不出形态（常量 / 变量 / 大写 / 反引号原始串 / map 取值 / 别的写法）的写入点。 */
  unrecognized: WritePoint[]
  /** `"reason":` 键写入点数（松匹配）。 */
  keyWriteCount: number
  /** 其中认得字面量的数量。 */
  keyLiteralCount: number
  /** `out["reason"] =` 赋值写入点数（松匹配）。 */
  assignWriteCount: number
  /** 其中认得字面量的数量。 */
  assignLiteralCount: number
  /** 其中是委派（`blocked.Reason`）的数量。 */
  assignDelegateCount: number
}

/** `"reason":` 键写入点（松匹配：不限定值形态）。 */
const REASON_KEY_WRITE = /"reason"\s*:/gu
/** 认得的键写入形态：`"reason": "xxx"`（小写 + 下划线）。 */
const REASON_KEY_LITERAL = /^"reason"\s*:\s*"([a-z_]+)"/u
/** `out["reason"] =` 赋值写入点（松匹配）。 */
const REASON_ASSIGN_WRITE = /out\["reason"\]\s*=/gu
/** 认得的赋值形态：`out["reason"] = "xxx"`。 */
const REASON_ASSIGN_LITERAL = /^out\["reason"\]\s*=\s*"([a-z_]+)"/u
/** 认得的赋值形态：委派 `out["reason"] = blocked.Reason`。 */
const REASON_ASSIGN_DELEGATE = /^out\["reason"\]\s*=\s*blocked\.Reason/u

/**
 * 判定一个写入点写的是什么（在**该偏移处**严格匹配，不做全局搜索）。
 * @param source - 擦除注释后的全文。
 * @param index - 写入点偏移。
 * @param form - 书写形态。
 * @returns 判词字面量；委派返回 `null`；认不出来返回 `undefined`。
 */
function classifyReasonWrite(source: string, index: number, form: 'key' | 'assign'): string | null | undefined {
  const tail = source.slice(index)
  const literal = (form === 'key' ? REASON_KEY_LITERAL : REASON_ASSIGN_LITERAL).exec(tail)
  if (literal !== null) return literal[1]!
  if (form === 'assign' && REASON_ASSIGN_DELEGATE.test(tail)) return null
  return undefined
}

/**
 * 从 `read.go` 的 `availability()` 抠判词字面量与委派关系，并**数清楚每一个写入点**。
 * @param source - `read.go` 全文。
 * @returns 抠出的形状；找不到函数时返回 `null`（调用方据此 throw）。
 */
export function availabilityReasonsFromReadGo(source: string): AvailabilitySourceReasons | null {
  const blanked = blankLineComments(source)
  const slice = goFuncSlice(blanked, 'func (h *Handlers) availability(')
  if (slice === null) return null

  const keyPoints = findWritePoints(blanked, slice, REASON_KEY_WRITE)
  const assignPoints = findWritePoints(blanked, slice, REASON_ASSIGN_WRITE)
  const writePoints: ReasonWritePoint[] = []
  const unrecognized: WritePoint[] = []
  let keyLiteralCount = 0
  let assignLiteralCount = 0
  let assignDelegateCount = 0

  for (const point of keyPoints) {
    const literal = classifyReasonWrite(blanked, point.index, 'key')
    if (literal === undefined) {
      unrecognized.push(point)
      continue
    }
    keyLiteralCount += 1
    writePoints.push({ ...point, literal, form: 'key' })
  }
  for (const point of assignPoints) {
    const literal = classifyReasonWrite(blanked, point.index, 'assign')
    if (literal === undefined) {
      unrecognized.push(point)
      continue
    }
    if (literal === null) assignDelegateCount += 1
    else assignLiteralCount += 1
    writePoints.push({ ...point, literal, form: 'assign' })
  }

  writePoints.sort((a, b) => a.index - b.index)
  unrecognized.sort((a, b) => a.index - b.index)
  return {
    literals: writePoints.filter(point => point.literal !== null).map(point => point.literal!),
    delegatesToPublishBlock: writePoints.some(point => point.literal === null),
    writePoints,
    unrecognized,
    keyWriteCount: keyPoints.length,
    keyLiteralCount,
    assignWriteCount: assignPoints.length,
    assignLiteralCount,
    assignDelegateCount,
  }
}

/**
 * **写入点计数**判据（复审 F1）：`availability()` 里每一处判词写入点都必须被认出来。
 *
 * 旧判据只在"一个都没抠到"时 throw，于是"新增判词写成了常量/大写"这类形态下集合仍
 * 相等 ⇒ 静默绿。这里把"写了几处"变成判据：认不出的写入点一旦存在即 throw，红信息
 * 带文件:行 + 原文。
 * @param parsed - {@link availabilityReasonsFromReadGo} 的结果。
 */
export function assertAvailabilityWritePointsAccounted(parsed: AvailabilitySourceReasons): void {
  const problems: string[] = []
  if (parsed.keyWriteCount !== parsed.keyLiteralCount) {
    problems.push(
      `${READ_GO_REPO_PATH} 的 availability() 里有 ${parsed.keyWriteCount} 处 \`"reason":\` 键写入点，`
      + `只认出 ${parsed.keyLiteralCount} 处小写字符串字面量。`,
    )
  }
  if (parsed.assignWriteCount !== parsed.assignLiteralCount + parsed.assignDelegateCount) {
    problems.push(
      `${READ_GO_REPO_PATH} 的 availability() 里有 ${parsed.assignWriteCount} 处 \`out["reason"] =\` 赋值写入点，`
      + `只认出 ${parsed.assignLiteralCount} 处小写字符串字面量 + ${parsed.assignDelegateCount} 处委派（blocked.Reason）。`,
    )
  }
  if (problems.length === 0) return
  throw new Error(
    `${problems.join('\n')}\n`
    + `认不出的写入点（不是小写字符串字面量、也不是委派）：\n${renderWritePoints(READ_GO_REPO_PATH, parsed.unrecognized)}\n`
    + '判词写成常量 / 变量 / 大写 / 反引号原始串 / map 取值 / 别的书写形状时，抠出来的集合会与客户端镜像'
    + '「恰好相等」⇒ 本对拍静默漏判（服务端多了一个客户端不认识的判词，闸门却是绿的；用户拿不到文案、'
    + '也不会在填表阶段被拦下）。\n'
    + '修法：把判词写回 `"reason": "xxx"` / `out["reason"] = "xxx"` 的小写字符串字面量（或委派'
    + ' `blocked.Reason`），并同步本包 availability-contract.ts。',
  )
}

/** `publishBlockOf` 里抠出来的终态判词形状（含**写入点计数**）。 */
export interface PublishBlockSourceReasons {
  /** 抠出的终态判词字面量。 */
  literals: string[]
  /** `Reason:` 字段的**全部**写入点（松匹配）。 */
  writePoints: WritePoint[]
  /** 认不出形态（非常量小写字符串字面量）的 `Reason:` 写入点。 */
  unrecognized: WritePoint[]
  /** `publishBlockOf` 里的 `Reason:` 写入点数。 */
  writeCount: number
  /** **整个 `publish.go`** 的 `Reason:` 写入点数（终态不许在别的函数里构造）。 */
  fileWideWriteCount: number
  /** `publishBlockOf` 里认不出形态的 `return`（既不是 `return nil` 也不是 `return &publishBlock{`）。 */
  unrecognizedReturns: WritePoint[]
  /** `publishBlockOf` 里的 `return` 总数。 */
  returnCount: number
  /** 其中 `return nil` 的数量。 */
  nilReturnCount: number
  /** 其中 `return &publishBlock{`（终态字面量）的数量。 */
  compositeReturnCount: number
}

/** `Reason:` 字段写入点（松匹配：不限定值形态）。 */
const PUBLISH_REASON_WRITE = /\bReason\s*:/gu
/** 认得的写入形态：`Reason: "xxx"`（小写 + 下划线）。 */
const PUBLISH_REASON_LITERAL = /^Reason\s*:\s*"([a-z_]+)"/u
/** `return` 写入点（松匹配）。 */
const RETURN_WRITE = /\breturn\b/gu
/** 认得的 return 形态：`return nil`。 */
const RETURN_NIL = /^return\s+nil\b/u
/** 认得的 return 形态：`return &publishBlock{`（终态字面量）。 */
const RETURN_COMPOSITE = /^return\s+&publishBlock\{/u

/**
 * 从 `publish.go` 的 `publishBlockOf()` 抠终态判词，并**数清楚每一个写入点**。
 * @param source - `publish.go` 全文。
 * @returns 抠出的形状；找不到函数时返回 `null`。
 */
export function publishBlockReasonsFromPublishGo(source: string): PublishBlockSourceReasons | null {
  const blanked = blankLineComments(source)
  const slice = goFuncSlice(blanked, 'func publishBlockOf(')
  if (slice === null) return null

  const writePoints = findWritePoints(blanked, slice, PUBLISH_REASON_WRITE)
  const fileWideWriteCount = findWritePoints(blanked, { body: blanked, start: 0 }, PUBLISH_REASON_WRITE).length
  const unrecognized: WritePoint[] = []
  const literals: string[] = []
  for (const point of writePoints) {
    const literal = PUBLISH_REASON_LITERAL.exec(blanked.slice(point.index))
    if (literal === null) {
      unrecognized.push(point)
      continue
    }
    literals.push(literal[1]!)
  }

  const returns = findWritePoints(blanked, slice, RETURN_WRITE)
  const unrecognizedReturns = returns.filter(point => {
    const tail = blanked.slice(point.index)
    return !RETURN_NIL.test(tail) && !RETURN_COMPOSITE.test(tail)
  })

  return {
    literals,
    writePoints,
    unrecognized,
    writeCount: writePoints.length,
    fileWideWriteCount,
    unrecognizedReturns,
    returnCount: returns.length,
    nilReturnCount: returns.filter(point => RETURN_NIL.test(blanked.slice(point.index))).length,
    compositeReturnCount: returns.filter(point => RETURN_COMPOSITE.test(blanked.slice(point.index))).length,
  }
}

/**
 * **写入点计数**判据（复审 F1）：`publishBlockOf` 里每一处 `Reason:` 都必须被认出来，
 * 且终态不许在别处构造。
 * @param parsed - {@link publishBlockReasonsFromPublishGo} 的结果。
 */
export function assertPublishBlockWritePointsAccounted(parsed: PublishBlockSourceReasons): void {
  const problems: string[] = []
  if (parsed.writeCount !== parsed.literals.length) {
    problems.push(
      `${PUBLISH_GO_REPO_PATH} 的 publishBlockOf 里有 ${parsed.writeCount} 个 \`Reason:\` 字段写入点，`
      + `只抠出 ${parsed.literals.length} 个字符串字面量（${parsed.literals.join(' / ')}）。`,
    )
  }
  if (parsed.fileWideWriteCount !== parsed.writeCount) {
    problems.push(
      `${PUBLISH_GO_REPO_PATH} 全文件有 ${parsed.fileWideWriteCount} 个 \`Reason:\` 字段写入点，`
      + `而 publishBlockOf 里只有 ${parsed.writeCount} 个 —— 终态判词在别处构造，本对拍扫不到那一处。`,
    )
  }
  if (parsed.unrecognizedReturns.length > 0) {
    problems.push(
      `${PUBLISH_GO_REPO_PATH} 的 publishBlockOf 里有 ${parsed.unrecognizedReturns.length} 处认不出形态的 return`
      + `（既不是 \`return nil\` 也不是 \`return &publishBlock{\`，例如把终态交给另一个函数/另一个文件构造）：\n`
      + renderWritePoints(PUBLISH_GO_REPO_PATH, parsed.unrecognizedReturns),
    )
  }
  if (problems.length === 0) return
  const details = parsed.unrecognized.length === 0
    ? ''
    : `\n认不出的写入点（不是小写字符串字面量）：\n${renderWritePoints(PUBLISH_GO_REPO_PATH, parsed.unrecognized)}`
  throw new Error(
    `${problems.join('\n')}${details}\n`
    + '终态判词写成常量 / 变量 / 反引号原始串 / 在别处构造时，抠出来的集合会与客户端镜像「恰好相等」'
    + '⇒ 本对拍静默漏判（服务端多了一个客户端不认识的判词，闸门却是绿的）。\n'
    + '修法：把判词写回 `Reason: "xxx"` 的小写字符串字面量（或同步扩展本对拍的抠法），'
    + '并同步本包 availability-contract.ts。',
  )
}

/**
 * 服务端 `availability` 可能回的全部判词（唯一真源的两个来源合起来）。
 *
 * 三个方向都不许静默：
 *  - 写入点认不出来（常量/大写/别的形状）⇒ {@link assertAvailabilityWritePointsAccounted} 抛；
 *  - 委派关系被拆掉（不再有 `out["reason"] = blocked.Reason`）⇒ 服务端判词集合变小，
 *    集合相等断言会红，逼人看一眼；
 *  - `publishBlockOf` 的写入点认不出来 ⇒ {@link assertPublishBlockWritePointsAccounted} 抛。
 * @param readGo - `read.go` 全文。
 * @param publishGo - `publish.go` 全文。
 * @returns 判词集合（去重、排序）。
 */
export function serverAvailabilityReasons(readGo: string, publishGo: string): string[] {
  const fromRead = availabilityReasonsFromReadGo(readGo)
  if (fromRead === null) {
    throw new Error(`${READ_GO_REPO_PATH} 里找不到 availability 函数（改名/搬走了？）：跨端对拍无法成立`)
  }
  assertAvailabilityWritePointsAccounted(fromRead)
  const reasons = [...fromRead.literals]
  if (fromRead.delegatesToPublishBlock) {
    const blocked = publishBlockReasonsFromPublishGo(publishGo)
    if (blocked === null) {
      throw new Error(`${PUBLISH_GO_REPO_PATH} 里找不到 publishBlockOf（read.go 仍在委派它）：跨端对拍无法成立`)
    }
    assertPublishBlockWritePointsAccounted(blocked)
    if (blocked.literals.length === 0) {
      throw new Error(`${PUBLISH_GO_REPO_PATH} 的 publishBlockOf 里一个 Reason 都没抠出来：抠法失效，必须修对拍而不是放行`)
    }
    reasons.push(...blocked.literals)
  }
  return [...new Set(reasons)].sort()
}

/** 一次 `can_publish` 写入点。 */
export interface CanPublishWritePoint extends WritePoint {
  /** 写下的值。 */
  value: boolean
}

/**
 * `availability()` 里 `can_publish` 的**写入点形状**与**从源码派生**的判词映射。
 *
 * 派生规则（写出来是为了让它可被打坏）：对每一个 `can_publish = true` 写入点，取它
 * **之前最近的一个判词写入点**作为归属判词，并要求该写入点落在那个判词分支的
 * `return` 之前 —— 那个判词就是"服务端认为可以发布"的判词。判词分支里没有 true 写入
 * 的，一律 `false`。
 *
 * ⚠️ 这是一条**文本级**派生（程序顺序 + "本分支的下一个 `return`"），不是控制流分析。
 * 它对着今天这份实现的形状（每个判词各自 `c.JSON(...); return`）成立；若有人把
 * `availability` 大改成"单出口 + 嵌套 if"，本用例可能**假红**。取舍是明确的：契约闸
 * 宁可在等价重构时吵一次（红信息会指名是哪一处写入点），也不放过"服务端给某个判词
 * 改了 can_publish 语义而客户端静态表不跟"这条静默漏判 —— 后者正是本闸存在的理由。
 */
export interface AvailabilityCanPublishShape {
  /** 全部 `can_publish` 写入点（gin.H 键 + `out[...] =` 赋值）。 */
  writePoints: CanPublishWritePoint[]
  /** 认不出形态（写了变量/表达式/换了个键）的写入点。 */
  unrecognized: WritePoint[]
  /** 置 `true` 的写入点归属的判词（去重、排序）。 */
  publishableReasons: string[]
  /** 置 `true` 却没落在任何判词分支里的写入点（对拍失效）。 */
  orphanTruePoints: CanPublishWritePoint[]
  /** 委派分支（终态 `blocked.Reason`）被置成了可发布 —— 服务端语义变了。 */
  delegateIsPublishable: boolean
}

/** `can_publish` 写入点（松匹配：不限定值形态、两种书写形态都收）。 */
const CAN_PUBLISH_WRITE = /(?:"can_publish"\s*:|out\["can_publish"\]\s*=)/gu
/** 认得的写入形态：键 `"can_publish": true|false` 或赋值 `out["can_publish"] = true|false`。 */
const CAN_PUBLISH_LITERAL = /^(?:"can_publish"\s*:\s*|out\["can_publish"\]\s*=\s*)(true|false)\b/u

/**
 * 找 `from` 之后的第一个 `return` 偏移（找不到返回 -1）。
 * @param source - 擦除注释后的全文。
 * @param from - 起始偏移。
 * @returns `return` 的偏移，或 -1。
 */
function nextReturnIndex(source: string, from: number): number {
  const pattern = /\breturn\b/gu
  pattern.lastIndex = from
  const match = pattern.exec(source)
  return match === null ? -1 : match.index
}

/**
 * 从 `availability()` 派生 `can_publish` 的判词映射（复审 F4 的"组合约束"钉子）。
 * @param source - `read.go` 全文。
 * @returns 形状；找不到函数时返回 `null`。
 */
export function availabilityCanPublishShape(source: string): AvailabilityCanPublishShape | null {
  const blanked = blankLineComments(source)
  const slice = goFuncSlice(blanked, 'func (h *Handlers) availability(')
  const reasons = availabilityReasonsFromReadGo(source)
  if (slice === null || reasons === null) return null

  const writePoints: CanPublishWritePoint[] = []
  const unrecognized: WritePoint[] = []
  for (const point of findWritePoints(blanked, slice, CAN_PUBLISH_WRITE)) {
    const value = CAN_PUBLISH_LITERAL.exec(blanked.slice(point.index))
    if (value === null) {
      unrecognized.push(point)
      continue
    }
    writePoints.push({ ...point, value: value[1] === 'true' })
  }

  const publishable = new Set<string>()
  const orphanTruePoints: CanPublishWritePoint[] = []
  let delegateIsPublishable = false
  for (const canPublish of writePoints) {
    if (!canPublish.value) continue
    // 归属判词 = 它之前最近的一个判词写入点。
    const owner = [...reasons.writePoints].reverse().find(point => point.index < canPublish.index)
    const branchEnd = owner === undefined ? -1 : nextReturnIndex(blanked, owner.index)
    if (owner === undefined || branchEnd < canPublish.index) {
      orphanTruePoints.push(canPublish)
      continue
    }
    if (owner.literal === null) delegateIsPublishable = true
    else publishable.add(owner.literal)
  }

  return {
    writePoints,
    unrecognized,
    publishableReasons: [...publishable].sort(),
    orphanTruePoints,
    delegateIsPublishable,
  }
}

/**
 * 集合比对（纯函数，供自证用合成输入驱动）。
 * @param server - 服务端抠出来的判词。
 * @param client - 客户端登记的判词。
 * @returns 两侧各自缺的判词（都为空 = 集合相等）。
 */
export function compareReasonSets(server: readonly string[], client: readonly string[]): { missingOnClient: string[], extraOnClient: string[] } {
  const serverSet = new Set(server)
  const clientSet = new Set(client)
  return {
    missingOnClient: [...serverSet].filter(reason => !clientSet.has(reason)).sort(),
    extraOnClient: [...clientSet].filter(reason => !serverSet.has(reason)).sort(),
  }
}

const readGo = readRepoFile(READ_GO_REPO_PATH)
const publishGo = readRepoFile(PUBLISH_GO_REPO_PATH)
const serverReasons = serverAvailabilityReasons(readGo, publishGo)
const clientReasons: readonly string[] = APP_AVAILABILITY_REASONS

describe('跨端对拍：availability 判词集合（服务端源码 ↔ 客户端镜像）', () => {
  it('两个真源都能抠出判词（抠不出来 ⇒ 红，不是 skip）', () => {
    expect(serverReasons.length).toBeGreaterThan(0)
    // 终态判词由 publishBlockOf 提供：委派关系断掉时整条闸就只会看着 root 判词，
    // 因此这里明确要求它是通的。
    expect(availabilityReasonsFromReadGo(readGo)?.delegatesToPublishBlock).toBe(true)
    expect(publishBlockReasonsFromPublishGo(publishGo)?.literals.length ?? 0).toBeGreaterThan(0)
  })

  /**
   * 主判据：**集合相等**（两侧任一方向多/少一个都红）。
   *
   * 变异验证：服务端加一个判词 ⇒ `missingOnClient` 非空；客户端删一个 ⇒ 同上；
   * 客户端加一个服务端没有的 ⇒ `extraOnClient` 非空。
   */
  it('服务端判词集合与客户端镜像集合完全相等（两个方向都不许多也不许少）', () => {
    const diff = compareReasonSets(serverReasons, clientReasons)
    expect(
      diff,
      `服务端判词 = ${JSON.stringify(serverReasons)}；客户端镜像 = ${JSON.stringify([...clientReasons])}。`
      + '缺的判词会被 fail-closed 解析器归成"查重不可用"（用户拿不到文案、也不会被拦下）；'
      + '多的判词是客户端在认一个服务端永远不会回的取值。',
    ).toEqual({ missingOnClient: [], extraOnClient: [] })
  })

  /**
   * **写入点计数**（复审 F1）：集合相等只在"抠法认得所有写入形态"时才等价于对拍。
   *
   * 这里把"服务端写了几处判词"变成判据：任一处不是小写字符串字面量、也不是委派 ⇒
   * 抛错。旧判据（只在零字面量时 throw）下，`Reason: publishReasonSuspended`（常量）
   * 与 `out["reason"] = "nameBlocked"`（大写）都是**全绿**的静默漏判。
   */
  it('服务端的每一处判词写入点都被认出来（常量/大写/别的形状 ⇒ 红，实测过两种静默漏判）', () => {
    const fromRead = availabilityReasonsFromReadGo(readGo)
    expect(fromRead).not.toBeNull()
    expect(fromRead!.unrecognized, 'read.go 有认不出形态的判词写入点').toEqual([])
    // 键写入点与赋值写入点分别计数（两种形态的值都必须认得）。
    expect(fromRead!.keyLiteralCount, `"reason": 键写入点共 ${fromRead!.keyWriteCount} 处`).toBe(fromRead!.keyWriteCount)
    expect(
      fromRead!.assignLiteralCount + fromRead!.assignDelegateCount,
      `out["reason"] = 写入点共 ${fromRead!.assignWriteCount} 处`,
    ).toBe(fromRead!.assignWriteCount)

    const blocked = publishBlockReasonsFromPublishGo(publishGo)
    expect(blocked).not.toBeNull()
    expect(blocked!.unrecognized, 'publish.go 有认不出形态的 Reason: 写入点').toEqual([])
    expect(blocked!.literals.length, `publishBlockOf 里 Reason: 写入点共 ${blocked!.writeCount} 处`).toBe(blocked!.writeCount)
    // 终态不许在别的函数里构造（同文件内的另一处 Reason: 就会被这里抓住）。
    expect(blocked!.fileWideWriteCount).toBe(blocked!.writeCount)
    // 每一次 return 都是字面量终态或 nil（防"终态交给另一个函数/另一个文件构造"）。
    expect(blocked!.unrecognizedReturns, 'publishBlockOf 里有认不出形态的 return').toEqual([])
    expect(blocked!.returnCount, 'publishBlockOf 的 return 数 != return nil + return &publishBlock{')
      .toBe(blocked!.nilReturnCount + blocked!.compositeReturnCount)
    expect(blocked!.compositeReturnCount, 'publishBlockOf 的终态字面量数 != 抠出的判词数')
      .toBe(blocked!.literals.length)
  })

  it('每个判词在文案表里都有一条（判词 → locale 键），没有多余条目', () => {
    expect(Object.keys(AVAILABILITY_REASON_COPY).slice().sort()).toEqual([...clientReasons].slice().sort())
  })

  it('文案表里的每个键在 zh / en 字典里都有非空文案（漏翻译即红）', () => {
    for (const [reason, copy] of Object.entries(AVAILABILITY_REASON_COPY)) {
      const keys = copy.hint === undefined ? [copy.label] : [copy.label, copy.hint]
      for (const key of keys) {
        expect(zh[key], `zh 字典缺 ${String(key)}（判词 ${reason}）`).toBeTruthy()
        expect(en[key], `en 字典缺 ${String(key)}（判词 ${reason}）`).toBeTruthy()
        expect(zh[key]!.trim(), `zh 字典的 ${String(key)} 是空白`).not.toBe('')
        expect(en[key]!.trim(), `en 字典的 ${String(key)} 是空白`).not.toBe('')
      }
    }
  })

  /**
   * 提交语义（`blocksSubmit`）必须与**服务端的发布能力**对齐。
   *
   * 服务端只在两个分支置 `can_publish=true`（read.go 的 availability：`app == nil`
   * 的空闲标识、以及 `checkOwner` 放行后的 `yours`）。因此"拦下提交"的判词集合 =
   * 除这两个之外的全部 —— 任一侧漂移（多拦一个合法名字 / 少拦一个注定失败的提交）都红。
   */
  it('拦下提交的判词 = 服务端不会回 can_publish=true 的那些（available / yours 之外）', () => {
    const blocking = Object.entries(AVAILABILITY_REASON_COPY)
      .filter(([, copy]) => copy.blocksSubmit)
      .map(([reason]) => reason)
      .sort()
    const expected = [...clientReasons].filter(reason => reason !== 'available' && reason !== 'yours').sort()
    expect(blocking).toEqual(expected)
    // 源码级钉子（复审 F8 去掉了"数出 2 次 `out["can_publish"] = true`"这种实现形状钉紧
    // —— 等价重构会假红）：改为"从源码派生的可发布判词集合"必须是 {available, yours}，
    // 且每一个 can_publish 写入点都必须是可识别的字面量形态。判据见下一条用例。
    expect(availabilityCanPublishShape(readGo)?.publishableReasons).toEqual(['available', 'yours'])
  })

  /**
   * `can_publish` 的**组合约束**（复审 F4）：把"哪些判词能发、哪些组合不可达"从服务端
   * 源码派生出来并逐项钉住。
   *
   * 客户端提交闸用的是**静态表**（不是响应里的 `can_publish`），两者等价的前提就是这条
   * 约束：`can_publish=true` 只出现在 `available` / `yours` 两个判词的分支里。
   * 服务端将来新增/改动某个判词的 `can_publish` 语义（例如给管理员接管加一个非 `yours`
   * 的可发布判词）时，这里的 `derived` 会与期望表不等 ⇒ 红。
   */
  it('can_publish 的判词映射从服务端源码派生，并逐项等于客户端静态表（不可达组合也钉住）', () => {
    const shape = availabilityCanPublishShape(readGo)
    expect(shape).not.toBeNull()
    // ① 写入点计数：每个 can_publish 写入点都必须是 `true` / `false` 字面量（变量/表达式 ⇒ 红）。
    expect(shape!.unrecognized, 'read.go 有认不出形态的 can_publish 写入点').toEqual([])
    // ② 置 true 的写入点必须落在某个判词分支里；委派分支（终态）不得被置成可发布。
    expect(shape!.orphanTruePoints, 'can_publish=true 没有落在任何判词分支里').toEqual([])
    expect(shape!.delegateIsPublishable, '委派给 publishBlockOf 的终态分支被置成了可发布').toBe(false)

    // ③ 从源码派生"判词 → 能不能发"。
    const derived: Record<string, boolean> = {}
    for (const reason of serverReasons) derived[reason] = shape!.publishableReasons.includes(reason)
    expect(
      derived,
      `从 ${READ_GO_REPO_PATH} 派生的可发布判词 = ${JSON.stringify(shape!.publishableReasons)}；`
      + '客户端的 blocksSubmit 静态表以这条组合约束为等价前提，任一侧变化都必须先重新拍板。',
    ).toEqual({ available: true, yours: true, taken: false, invalid: false, frozen: false, retired: false })

    // ④ 不可达组合（客户端静态表依赖它们今天不可达）。
    for (const reason of ['taken', 'invalid', 'frozen', 'retired']) {
      expect(derived[reason], `${reason} + can_publish=true 是服务端不可达的组合，源码里出现了 ⇒ 语义变了`).toBe(false)
    }
    for (const reason of ['available', 'yours']) {
      expect(derived[reason], `${reason} + can_publish=false 是服务端不可达的组合，源码里出现了 ⇒ 语义变了`).toBe(true)
    }

    // ⑤ 客户端静态表与派生映射逐项相等（两个方向）。
    const clientNonBlocking = Object.entries(AVAILABILITY_REASON_COPY)
      .filter(([, copy]) => !copy.blocksSubmit)
      .map(([reason]) => reason)
      .sort()
    expect(clientNonBlocking).toEqual(Object.entries(derived).filter(([, canPublish]) => canPublish).map(([reason]) => reason).sort())
  })

  it('这份对拍真的会红（对合成的"服务端多一个判词 / 客户端少一个判词"自证）', () => {
    // 服务端加第三态终态判词（`publishBlockOf` 里多一条 `Reason: "suspended"`）。
    const mutatedPublish = publishGo.replace(
      '\tif app.FrozenAt != nil {',
      '\tif app.SuspendedAt != nil {\n\t\treturn &publishBlock{Reason: "suspended", Err: apperr.New(apperr.CodeAppFrozen, "暂停")}\n\t}\n\tif app.FrozenAt != nil {',
    )
    expect(mutatedPublish, '合成锚点失效（`publishBlockOf` 里找不到 `\tif app.FrozenAt != nil {`）：真源被改写了，本自证要跟着改').not.toBe(publishGo)
    const mutatedServer = serverAvailabilityReasons(readGo, mutatedPublish)
    expect(mutatedServer).toContain('suspended')
    expect(compareReasonSets(mutatedServer, clientReasons).missingOnClient).toEqual(['suspended'])

    // 客户端少一个判词（模拟"映射表/联合类型漏登记"）。
    const shrunkenClient = clientReasons.filter(reason => reason !== clientReasons[0])
    expect(compareReasonSets(serverReasons, shrunkenClient).missingOnClient).toEqual([clientReasons[0]])

    // 反向自证：原文件必须**相等** —— 否则上面两条"不等"可能只是因为抠法坏了。
    expect(compareReasonSets(serverReasons, clientReasons)).toEqual({ missingOnClient: [], extraOnClient: [] })
  })

  /**
   * 复审 F1 的两条**原始形态**自证：旧判据下它们全绿，现在必须红。
   *
   * 这两条直接在内存里改写源码文本（不动磁盘文件），是"写入点计数"这条判据的可执行证明。
   */
  it('写入点计数真的会红（常量型第三终态 / 大写判词 —— 复审实测的两种静默漏判形态）', () => {
    // 形态 1：新终态写成**常量**（`Reason: publishReasonSuspended`）。
    const constPublish = publishGo
      .replace('\tif app.FrozenAt != nil {', '\tif app.SuspendedAt != nil {\n\t\treturn &publishBlock{Reason: publishReasonSuspended, Err: apperr.New(apperr.CodeAppFrozen, "暂停")}\n\t}\n\tif app.FrozenAt != nil {')
      .replace('type publishBlock struct {', 'const publishReasonSuspended = "suspended"\n\ntype publishBlock struct {')
    expect(constPublish, '合成锚点失效（`publishBlockOf` 的冻结分支或 `type publishBlock struct {` 不在了）：真源被改写了，本自证要跟着改').not.toBe(publishGo)
    expect(() => serverAvailabilityReasons(readGo, constPublish)).toThrow(/写入点/u)
    // 旧判据（只比"抠出来的集合"）在这种形态下是**全绿**的 —— 这就是"静默漏判"：
    // 常量型第三终态抠不出来，集合与客户端镜像仍然相等。
    const oldStyleServerReasons = [...new Set([
      ...availabilityReasonsFromReadGo(readGo)!.literals,
      ...publishBlockReasonsFromPublishGo(constPublish)!.literals,
    ])].sort()
    expect(
      compareReasonSets(oldStyleServerReasons, clientReasons),
      '常量型第三终态在"只比集合"的旧判据下必须仍然相等（否则这条自证没打在静默漏判上）',
    ).toEqual({ missingOnClient: [], extraOnClient: [] })

    // 形态 2：判词写成**大写**（抠取用的字符类是 `[a-z_]+`，抓不到）。
    const upperRead = readGo.replace(
      '\tif oerr := h.checkOwner(u, appID, app); oerr != nil {',
      '\tif app.SuspendedAt != nil {\n\t\tout["reason"] = "nameBlocked"\n\t\tc.JSON(http.StatusOK, out)\n\t\treturn\n\t}\n\tif oerr := h.checkOwner(u, appID, app); oerr != nil {',
    )
    expect(upperRead, '合成锚点失效（availability 里找不到 `\tif oerr := h.checkOwner(u, appID, app); oerr != nil {`）：真源被改写了，本自证要跟着改').not.toBe(readGo)
    expect(() => serverAvailabilityReasons(upperRead, publishGo)).toThrow(/写入点/u)
    // 同上：大写判词在旧判据下也是全绿（字符类 `[a-z_]+` 抓不到它）。
    const oldStyleUpperReasons = [...new Set([
      ...availabilityReasonsFromReadGo(upperRead)!.literals,
      ...publishBlockReasonsFromPublishGo(publishGo)!.literals,
    ])].sort()
    expect(
      compareReasonSets(oldStyleUpperReasons, clientReasons),
      '大写判词在"只比集合"的旧判据下必须仍然相等（否则这条自证没打在静默漏判上）',
    ).toEqual({ missingOnClient: [], extraOnClient: [] })

    // 形态 3：委派被换成 map 取值（既不认字面量、也不再是 `blocked.Reason`）。
    const mappedRead = readGo.replace('\t\tout["reason"] = blocked.Reason', '\t\tout["reason"] = terminalReasons[blocked.Reason]')
    expect(mappedRead, '合成锚点失效（availability 里找不到 `\t\tout["reason"] = blocked.Reason`）：真源被改写了，本自证要跟着改').not.toBe(readGo)
    expect(() => serverAvailabilityReasons(mappedRead, publishGo)).toThrow(/写入点/u)

    // 反向自证：原文件必须能过计数（否则上面三条"抛错"可能只是因为抠法坏了）。
    expect(() => serverAvailabilityReasons(readGo, publishGo)).not.toThrow()
  })

  /** 复审 F4：`can_publish` 的派生映射真的会红（把 true 搬到 `taken` 分支）。 */
  it('can_publish 映射真的会红（把 can_publish=true 搬到 taken 分支 ⇒ 派生集合变宽）', () => {
    const widened = readGo.replace(
      '\t\tout["reason"] = "taken"',
      '\t\tout["reason"] = "taken"\n\t\tout["can_publish"] = true',
    )
    expect(widened, '合成锚点失效（availability 里找不到 `\t\tout["reason"] = "taken"`）：真源被改写了，本自证要跟着改').not.toBe(readGo)
    const shape = availabilityCanPublishShape(widened)
    expect(shape?.publishableReasons).toEqual(['available', 'taken', 'yours'])
    // 派生映射与客户端静态表不再相等 ⇒ 上一条用例会红。
    expect(shape?.publishableReasons).not.toEqual(['available', 'yours'])
    // 反向自证：原文件仍是两判词。
    expect(availabilityCanPublishShape(readGo)?.publishableReasons).toEqual(['available', 'yours'])
  })

  it('服务端侧改名（函数被搬走）时抛错，而不是静默通过', () => {
    expect(() => serverAvailabilityReasons(readGo.replace('func (h *Handlers) availability(', 'func (h *Handlers) availabilityRenamed('), publishGo))
      .toThrow(/找不到 availability 函数/u)
    expect(() => serverAvailabilityReasons(readGo, publishGo.replace('func publishBlockOf(', 'func publishBlockOfRenamed(')))
      .toThrow(/找不到 publishBlockOf/u)
  })
})

describe('fail-closed 反向：未登记的判词绝不落成"可用"', () => {
  it('parseAvailability 对未登记判词返回 null（不猜测、不回落）', () => {
    expect(parseAvailability({ reason: 'suspended', can_publish: true })).toBeNull()
    expect(parseAvailability({ reason: '' })).toBeNull()
    expect(parseAvailability({ reason: 42 })).toBeNull()
    // 自证：登记过的判词必须被接受 —— 否则上面那条可能只是"解析器全拒"。
    for (const reason of APP_AVAILABILITY_REASONS) {
      expect(parseAvailability({ reason }), reason).not.toBeNull()
    }
  })

  it('isAvailabilityReason 只认登记过的取值（未知即 false）', () => {
    for (const reason of APP_AVAILABILITY_REASONS) expect(isAvailabilityReason(reason)).toBe(true)
    for (const bad of ['suspended', 'AVAILABLE', '', null, undefined, 7, {}]) expect(isAvailabilityReason(bad)).toBe(false)
  })

  it('未知判词的整条链路：UNEXPECTED_RESPONSE（不是 ok=true，更不是 available）', async () => {
    const outcome = await checkAppIdAvailability('whatever', {
      fetch: (async () => new Response(JSON.stringify({
        app_id: 'whatever', valid: true, exists: false, available: true,
        owned_by_you: false, can_publish: true, reason: 'suspended', code: '', message: '', hints: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.code).toBe('UNEXPECTED_RESPONSE')
    // 反向自证：同一形状、判词换成登记过的取值时链路是 ok 的。
    const known = await checkAppIdAvailability('whatever', {
      fetch: (async () => new Response(JSON.stringify({
        app_id: 'whatever', valid: true, exists: false, available: true,
        owned_by_you: false, can_publish: true, reason: 'available', code: '', message: '', hints: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    })
    expect(known.ok).toBe(true)
  })

  it('客户端登记的判词全集不是"只认得 available"（防把解析器写成恒真）', () => {
    const kinds: AppAvailabilityReason[] = ['available', 'yours', 'taken', 'invalid']
    for (const kind of kinds) expect(clientReasons).toContain(kind)
    expect(clientReasons.length).toBeGreaterThanOrEqual(kinds.length)
  })
})
