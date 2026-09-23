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
 * ## 判据（"只改一侧必红"两侧都成立）
 *
 *  1. 服务端集合 == 客户端集合（{@link APP_AVAILABILITY_REASONS}）⇒ 服务端加一个判词红；
 *  2. 客户端集合 == 文案表键集合（`Record<AppAvailabilityReason, …>` 另由 tsc 兜底）
 *     ⇒ 客户端少一个判词红；
 *  3. 文案表里每个键在 zh / en 字典里都有非空文案 ⇒ 漏翻译红；
 *  4. 反向：**未登记**的判词必须走 fail-closed（`parseAvailability` → `null`，
 *     `checkAppIdAvailability` → `UNEXPECTED_RESPONSE`），绝不落成"可用"。
 *
 * ---- 变异验证（逐个实跑，见报告） ----
 *   - 服务端多一个未登记的判词（`publishBlockOf` 里加第三态 `Reason: "suspended"`）
 *     ⇒ 第 1 组红；
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
 * 取一个 Go 函数（或方法）的函数体文本。
 *
 * 只做 `\nfunc ` 边界切分 —— 与本仓 `appcfg-contract.spec.ts` 同款抠法：不解析 Go，
 * 只依赖"函数之间以行首 func 分隔"这一稳定形状。
 * @param source - Go 源文件全文。
 * @param signature - 函数签名前缀（如 `func (h *Handlers) availability(`）。
 * @returns 函数体文本（含签名行）。
 */
export function goFuncBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  if (start < 0) return ''
  const nextFunc = source.indexOf('\nfunc ', start)
  return source.slice(start, nextFunc < 0 ? undefined : nextFunc)
}

/** `read.go` 的 availability 里抠出来的判词形状。 */
export interface AvailabilitySourceReasons {
  /** 直接写死在 availability 里的判词（gin.H 字面量键 + `out["reason"] = "x"`）。 */
  literals: string[]
  /** 是否把终态判词委派给 `publishBlockOf`（`out["reason"] = blocked.Reason`）。 */
  delegatesToPublishBlock: boolean
}

/**
 * 从 `read.go` 的 `availability()` 抠判词字面量与委派关系。
 * @param source - `read.go` 全文。
 * @returns 抠出的形状；找不到函数时返回 `null`（调用方据此 throw）。
 */
export function availabilityReasonsFromReadGo(source: string): AvailabilitySourceReasons | null {
  const body = goFuncBody(source, 'func (h *Handlers) availability(')
  if (body === '') return null
  // 去掉行注释：注释里出现的 `"reason"` 例子不该被当成真取值。
  const stripped = body.replace(/\/\/[^\n]*/gu, '')
  const literals = [
    ...[...stripped.matchAll(/"reason"\s*:\s*"([a-z_]+)"/gu)].map(match => match[1]!),
    ...[...stripped.matchAll(/out\["reason"\]\s*=\s*"([a-z_]+)"/gu)].map(match => match[1]!),
  ]
  return {
    literals,
    delegatesToPublishBlock: /out\["reason"\]\s*=\s*blocked\.Reason/u.test(stripped),
  }
}

/**
 * 从 `publish.go` 的 `publishBlockOf()` 抠终态判词。
 * @param source - `publish.go` 全文。
 * @returns 判词列表；找不到函数时返回 `null`。
 */
export function publishBlockReasonsFromPublishGo(source: string): string[] | null {
  const body = goFuncBody(source, 'func publishBlockOf(')
  if (body === '') return null
  const stripped = body.replace(/\/\/[^\n]*/gu, '')
  return [...stripped.matchAll(/Reason:\s*"([a-z_]+)"/gu)].map(match => match[1]!)
}

/**
 * 服务端 `availability` 可能回的全部判词（唯一真源的两个来源合起来）。
 *
 * 委派关系被拆掉（不再有 `out["reason"] = blocked.Reason`）时**不静默忽略**
 * `publishBlockOf`：那时服务端判词集合变小，集合相等断言会红，逼人看一眼。
 * @param readGo - `read.go` 全文。
 * @param publishGo - `publish.go` 全文。
 * @returns 判词集合（去重、排序）。
 */
export function serverAvailabilityReasons(readGo: string, publishGo: string): string[] {
  const fromRead = availabilityReasonsFromReadGo(readGo)
  if (fromRead === null) {
    throw new Error(`${READ_GO_REPO_PATH} 里找不到 availability 函数（改名/搬走了？）：跨端对拍无法成立`)
  }
  const reasons = [...fromRead.literals]
  if (fromRead.delegatesToPublishBlock) {
    const blocked = publishBlockReasonsFromPublishGo(publishGo)
    if (blocked === null) {
      throw new Error(`${PUBLISH_GO_REPO_PATH} 里找不到 publishBlockOf（read.go 仍在委派它）：跨端对拍无法成立`)
    }
    if (blocked.length === 0) {
      throw new Error(`${PUBLISH_GO_REPO_PATH} 的 publishBlockOf 里一个 Reason 都没抠出来：抠法失效，必须修对拍而不是放行`)
    }
    reasons.push(...blocked)
  }
  return [...new Set(reasons)].sort()
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
    expect(publishBlockReasonsFromPublishGo(publishGo)?.length ?? 0).toBeGreaterThan(0)
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
    // 源码级钉子：availability 里置 can_publish=true 的位置就是上面那两处。
    const body = goFuncBody(readGo, 'func (h *Handlers) availability(')
    expect([...body.matchAll(/out\["can_publish"\]\s*=\s*true/gu)]).toHaveLength(2)
  })

  it('这份对拍真的会红（对合成的"服务端多一个判词 / 客户端少一个判词"自证）', () => {
    // 服务端加第三态终态判词（`publishBlockOf` 里多一条 `Reason: "suspended"`）。
    const mutatedPublish = publishGo.replace(
      '\tif app.FrozenAt != nil {',
      '\tif app.SuspendedAt != nil {\n\t\treturn &publishBlock{Reason: "suspended", Err: apperr.New(apperr.CodeAppFrozen, "暂停")}\n\t}\n\tif app.FrozenAt != nil {',
    )
    expect(mutatedPublish).not.toBe(publishGo)
    const mutatedServer = serverAvailabilityReasons(readGo, mutatedPublish)
    expect(mutatedServer).toContain('suspended')
    expect(compareReasonSets(mutatedServer, clientReasons).missingOnClient).toEqual(['suspended'])

    // 客户端少一个判词（模拟"映射表/联合类型漏登记"）。
    const shrunkenClient = clientReasons.filter(reason => reason !== clientReasons[0])
    expect(compareReasonSets(serverReasons, shrunkenClient).missingOnClient).toEqual([clientReasons[0]])

    // 反向自证：原文件必须**相等** —— 否则上面两条"不等"可能只是因为抠法坏了。
    expect(compareReasonSets(serverReasons, clientReasons)).toEqual({ missingOnClient: [], extraOnClient: [] })
  })

  it('服务端侧改名（函数被搬走）时抛错，而不是静默通过', () => {
    expect(() => serverAvailabilityReasons(readGo.replace('func (h *Handlers) availability(', 'func (h *Handlers) availabilityRenamed('), publishGo))
      .toThrow(/找不到 availability 函数/u)
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
