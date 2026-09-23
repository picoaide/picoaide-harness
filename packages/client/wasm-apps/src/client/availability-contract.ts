/**
 * 标识查重判词（availability 响应的 `reason`）的**客户端镜像**。
 *
 * ## 为什么单独一个模块
 *
 * `reason` 的真源在服务端，且**只有一处**：`server/internal/wasmapp/api/read.go`
 * 的 `availability()` 写下的字面量，加上它委派给
 * `server/internal/wasmapp/api/publish.go` 的 `publishBlockOf()` 的两个终态判词。
 * 客户端为了在填表阶段给出可读结论，必须持有一份镜像 —— 于是就有了**两份可能漂移的
 * 取值集合**。这正是本项目反复出现的那类缺陷（"两端各钉自己的字面量"）：R3-A 的 A-4
 * 就是它的实例，服务端新增了 `frozen` / `retired` 两个判词，客户端联合类型里没有，
 * 于是 fail-closed 解析器把它们全归成"查重不可用"（不误报可用，但用户拿不到新文案）。
 *
 * 因此这里的取值集合是**运行时数组**（不是只存在于类型层的联合），并且：
 *
 *  1. {@link AppAvailabilityReason} 由数组派生（数组就是联合类型的取值集合）；
 *  2. {@link AVAILABILITY_REASON_COPY} 是 `Record<AppAvailabilityReason, …>` ——
 *     少一个 key 就**编译不过**（tsc，`check` 的第一步）；多一个同样是编译错误；
 *  3. `availability-contract.spec.ts` 读**服务端源码文本**解析出真实取值集合，
 *     与本模块做**集合相等**断言（读不到就 throw，不 skip）。
 *
 * 三条合起来才挡住"只改一侧"：改服务端 ⇒ 对拍红；改客户端数组 ⇒ 对拍红 + tsc 红；
 * 改文案表 ⇒ tsc 红 + 对拍红。
 *
 * @module @picoaide/dsh-wasm-apps/client/availability-contract
 */
import type { AppCenterKey } from './locales.ts'

/**
 * 服务端 `GET /apps/wasm/:app_id/availability` 可能回的全部判词。
 *
 * 顺序与语义（判词的**顺序**不进契约，只有集合进）：
 *  - `available` —— 空闲标识，可以发首版；
 *  - `yours` —— 是你自己的正常应用，可以发新版本；
 *  - `taken` —— 被别人占着（含空 owner 的历史行），换名字；
 *  - `invalid` —— 名字本身不合规（`valid=false`，不是错误信封）；
 *  - `frozen` —— 你的应用被冻结（R37 退役流程第一步），解冻后才能发；
 *  - `retired` —— 你的应用已删除（退役），标识与版本号永久占位。
 *
 * ⚠️ 新增/删除取值必须**同时**动服务端与这里，对拍用例才算数（见模块头）。
 */
export const APP_AVAILABILITY_REASONS = [
  'available',
  'yours',
  'taken',
  'invalid',
  'frozen',
  'retired',
] as const

/** 判词联合类型；取值集合 = {@link APP_AVAILABILITY_REASONS}。 */
export type AppAvailabilityReason = (typeof APP_AVAILABILITY_REASONS)[number]

/**
 * 形状守卫：`reason` 是不是登记过的判词。
 *
 * **fail-closed** 的唯一实现（`parseAvailability` 用它）：认不出来即返回 `false`，
 * 调用方据此判"查重结果不可用"，绝不默认成"可用" —— 那会放行一次注定失败的发布。
 * @param value - 载荷里的 `reason` 原值。
 * @returns 是否是登记过的判词。
 */
export function isAvailabilityReason(value: unknown): value is AppAvailabilityReason {
  return typeof value === 'string' && (APP_AVAILABILITY_REASONS as readonly string[]).includes(value)
}

/** 一条判词的展示文案与提交语义：标题必有，`hint` 可选。 */
export interface AvailabilityReasonCopy {
  /** 本地化的标题（服务端 `message` 为空时的兜底；中英由 locales 字典各自提供）。 */
  label: AppCenterKey
  /** 本地化的补充说明（可行动的那一句），没有就不追加。 */
  hint?: AppCenterKey
  /**
   * 这个判词是否意味着"提交注定失败"，据此在**填表阶段**就地拦下提交（省一次上传）。
   *
   * **必填**（不是可选）：新增判词时必须显式回答这个问题，不许靠"忘了写"静默放行
   * 一次注定被服务端拒掉的 32 MiB 上传。判据是服务端的 `can_publish` —— 服务端说
   * 不能发的判词，客户端就不该放行提交。
   */
  blocksSubmit: boolean
}

/**
 * 判词 → 本地化文案键（**每种判词都必须有一条**）。
 *
 * 取值优先服务端 `message`（它与发布那一刻的拒绝逐字同源），本地键是兜底与 hint 来源
 * —— 与 `taken` / `invalid` 的既有口径一致：用户不会以为"查重说一套、提交说另一套"。
 */
export const AVAILABILITY_REASON_COPY: Record<AppAvailabilityReason, AvailabilityReasonCopy> = {
  available: { label: 'appCenter.availabilityFree', blocksSubmit: false },
  yours: { label: 'appCenter.availabilityYours', blocksSubmit: false },
  taken: { label: 'appCenter.availabilityTaken', hint: 'appCenter.availabilityTakenHint', blocksSubmit: true },
  invalid: { label: 'appCenter.availabilityInvalid', blocksSubmit: true },
  // 终态判词（R3-A A-4）：服务端 `publishBlockOf` 给的两个取值，`can_publish=false`。
  // 文案与 hint 都指向**下一步动作**（解冻 / 新建），否则用户看到"不能发"却不知道能做什么。
  frozen: { label: 'appCenter.availabilityFrozen', hint: 'appCenter.availabilityFrozenHint', blocksSubmit: true },
  retired: { label: 'appCenter.availabilityRetired', hint: 'appCenter.availabilityRetiredHint', blocksSubmit: true },
}
