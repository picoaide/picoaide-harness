/**
 * 发布编排的**客户端半边**：应用中心面板 → 本机 `/api/pico/apps/wasm/publish`。
 *
 * 为什么由页面发起（而不是给 AI 一条工具面）：页面是"经 launch token 换过票的浏览器
 * 页面"，**天然持有** `dsh-auth-*` 持有性证明 —— 本地写面的围栏对它是透明的（先例：
 * `CapabilityCenterPanel` 的上传就是页面上下文直发本地写面）。宿主拿到请求后按 §4.2 的
 * 客户端契约出站（90 s 预算；`base64 > 8 MiB` 自动分片 + 续传），**这份编排只有一份实现**
 * （`packages/host/enterprise/src/wasm-apps.ts`）——面板不复制、也不旁路任何一条路径。
 *
 * 本模块只做四件事，全是纯逻辑（可单测、无 React）：
 *  1. 把表单草稿拼成宿主约定的请求体（`config` 的字段名是**服务端契约**：
 *     `access` / `whitelist` / `purpose` / `data_sensitivity` / `owner`
 *     —— 旧的 `visible` 已删除、`login_required` 被 `access` 取代，字段集合是**封闭**的，
 *     多发一个旧字段就等于发布必然被拒）；
 *  2. 读文件 → base64（分片 32 KiB 累加，避免 `String.fromCharCode(...bigArray)` 爆栈）；
 *  3. **预校验**（{@link validatePublishDraft}）：把服务端已有的形态规则搬到提交之前，
 *     免得用户白等一次 90 s 的往返。它只做加法 —— 拦下的必然是服务端也会拒的；
 *  4. 把服务端**结构化错误** `{error:{code,message,details,hints}}` 一字段不丢地解析出来
 *     —— 第一消费者是 AI，也是给员工看的：只显示"失败"等于把可自修的信息丢掉（§8）。
 *
 * @module @picoaide/dsh-wasm-apps/client/publish-app
 */

import { t } from './locales.ts'
import {
  APP_ID_ALL_DIGITS_PATTERN,
  APP_ID_MAX_LENGTH,
  APP_ID_PATTERN,
  APP_ID_PUNYCODE_PREFIX,
  DEFAULT_ACCESS,
  VERSION_PATTERN,
  WHITELIST_MAX,
  WRITABLE_ACCESS_MODES,
  parseWindowRatio,
  type AccessMode,
  type AppWindowSpec,
} from './appcfg-contract.ts'

/** 本地发布入口（宿主路由；唯一的发布链路）。 */
export const PUBLISH_PATH = '/api/pico/apps/wasm/publish'

/** 应用配置草稿（字段名与 `picoaide.app.json` 一一对应）。 */
export interface PublishConfigDraft {
  /**
   * 访问模式（**写侧只有两值**：`login | whitelist`；缺省 `login`）。
   *
   * 取代了旧的 `visible` + `login_required` 两个布尔：那两个的组合里有一半是
   * 无意义甚至自相矛盾的（§4.2 的 R25/R26）；历史取值 `public` 已退场（I6）。
   */
  access: AccessMode
  /**
   * 准入名单（手填账号）。
   *
   * **平台不比对**（R24 不变）：平台只把身份与访问模式注入帧，名单判定仍由应用读
   * 自己的配置做。`access=whitelist` 时服务端要求非空，否则应用对所有人都不可用。
   */
  whitelist: string[]
  /** 用途声明（首次发布必填）。 */
  purpose: string
  /** 数据敏感度声明（首次发布必填）。 */
  dataSensitivity: string
  /** 负责人声明（首次发布必填；不是平台归属）。 */
  owner: string
  /**
   * 窗口声明（F3/§6）。**缺席 = 不声明**（不是"锁了缺省比例"）。
   *
   * 客户端把它放进 `config.window`，服务端字段集合必须同步包含它
   * （见 `appcfg-contract.ts` 的 `PENDING_SERVER_CONFIG_FIELDS`）。
   */
  window?: AppWindowSpec
}

/** 一次发布的表单草稿。 */
export interface PublishDraft {
  appId: string
  version: string
  title: string
  changelog: string
  config: PublishConfigDraft
}

/** 待发布的产物（文件选择的结果；`bytes` 是真字节，不是文件名）。 */
export interface PublishFile {
  name: string
  bytes: Uint8Array
}

/**
 * 「对已有应用发新版」时目录行提供的**预填基线**（P1-3）。
 *
 * 为什么必须有它：发布表单原先的初值是硬编码的（`access = login`、
 * `data_sensitivity = internal`），而对已有应用发新版时提交会**无条件**带上全部
 * 五个配置字段 —— 作者不动单选框，一个 `access=public`（**历史取值**：2026-09-19 前
 * 写侧还接受它，现已废弃；这里记录的是当时的成因）的应用就会静默变成 `login`
 * （访问范围被改写，服务端还会因此写一条 `wasm_app_access_change` 审计）。
 * 预填是这条链路上唯一的"当前值"来源。
 *
 * `purpose` / `whitelist` 只在**发布者本人**的目录行里出现（服务端按调用者下发，
 * 理由见 `appcfg-contract.ts` 的 `CATALOG_ROW_AUTHOR_FIELDS`）：它们缺席时表单
 * 留空，由作者补填，而不是拿一个编造的默认值凑数。
 */
export interface PublishTarget {
  appId: string
  title: string
  /** 当前线上的访问级别（服务端目录行的 `access`）。 */
  access: AccessMode
  /** 当前线上版本（服务端目录行的 `current_version`；空串 = 服务端没有版本行）。 */
  currentVersion: string
  /** 负责人声明（目录行的 `responsible`；不是平台归属）。 */
  owner: string
  /** 用途声明（仅发布者本人可见）。 */
  purpose?: string
  /** 准入名单（仅发布者本人可见）。 */
  whitelist?: string[]
  /** 作者声明的窗口规格（目录行下发时预填；缺席 = 不预填）。 */
  window?: AppWindowSpec
}

/**
 * 发布表单的**初始值**（从 {@link PublishTarget} 推出；纯函数，便于单测）。
 *
 * 纪律（P1-3）：
 *  - 有基线 ⇒ `access` / `whitelist` / `purpose` / `owner` / `title` **全部预填**；
 *  - `data_sensitivity` **不在这个类型里** —— 平台没有它的默认值
 *    （`appcfg.json` 的 `data_sensitivity.hints` 原话："不要指望界面或平台替你填"），
 *    表单初值恒为空串，必须由作者声明。类型里没有这个键是**结构性**保证：
 *    想给它塞默认值就得先改这个类型（那时对拍用例会红）。
 */
export interface PublishFormInitial {
  appId: string
  title: string
  access: AccessMode
  /**
   * 当前线上的访问级别；`undefined` = **首版**（没有"当前值"可比，
   * 因此也不会有"改范围"的二次确认）。
   */
  currentAccess: AccessMode | undefined
  /** 当前线上版本（展示用；**不预填版本号输入框** —— 预填必然撞"严格递增"）。 */
  currentVersion: string
  whitelistText: string
  purpose: string
  owner: string
  /** 窗口比例输入框原文（`""` = 作者没声明；`"16:9"` 与 `"1.7778"` 都可）。 */
  windowRatioText: string
  /** 窗口宽度输入框原文（`""` = 没声明）。 */
  windowWidthText: string
  /** 窗口高度输入框原文（`""` = 没声明）。 */
  windowHeightText: string
}

/**
 * 由目录行基线推出表单初值。
 *
 * 无基线（首版发布）时 `access` 仍是 {@link DEFAULT_ACCESS}（写漏不该让应用意外
 * 变成匿名可达），但 `currentAccess` 为 `undefined` —— "缺省选中"与"已有当前值"
 * 是两件事，混在一起就没了"访问范围要被改动"的判据。
 * @param target - 目录行基线；首版发布时为 `undefined`。
 * @returns 表单初值。
 */
export function initialFormState(target?: PublishTarget): PublishFormInitial {
  if (target === undefined) {
    return {
      appId: '',
      title: '',
      access: DEFAULT_ACCESS,
      currentAccess: undefined,
      currentVersion: '',
      whitelistText: '',
      purpose: '',
      owner: '',
      windowRatioText: '',
      windowWidthText: '',
      windowHeightText: '',
    }
  }
  return {
    appId: target.appId,
    title: target.title,
    access: target.access,
    currentAccess: target.access,
    currentVersion: target.currentVersion,
    whitelistText: (target.whitelist ?? []).join(', '),
    purpose: target.purpose ?? '',
    owner: target.owner,
    windowRatioText: formatWindowRatio(target.window?.ratio),
    windowWidthText: target.window?.width === undefined ? '' : String(target.window.width),
    windowHeightText: target.window?.height === undefined ? '' : String(target.window.height),
  }
}

/**
 * 把归一化后的比例还原成输入框文本（`"16:9"` 形态优先，非整数比用小数）。
 * @param ratio - 归一化比例（`width / height`）。
 * @returns 文本；`undefined` ⇒ 空串（不预填 = 不声明）。
 */
export function formatWindowRatio(ratio: number | undefined): string {
  if (ratio === undefined) return ''
  const text = ratio.toFixed(4).replace(/0+$/u, '').replace(/\.$/u, '')
  return text === '' ? '' : text
}

/**
 * 把窗口输入框的三段原文归一化成作者声明（F3/§6）。
 *
 * 只在**解析得出来**时带上对应字段：非法输入由 {@link validatePublishDraft} 报错并
 * 阻止提交，这里不猜、也不拿缺省值顶替（"没声明"与"声明了缺省"是两件事）。
 * @param ratioText - 比例输入框原文（`"16:9"` / `"1.7778"` / `""`）。
 * @param widthText - 宽度输入框原文（十进制像素 / `""`）。
 * @param heightText - 高度输入框原文。
 * @returns 规格；一个字段都解析不出来 ⇒ `undefined`（不发 `window` 键）。
 */
export function windowSpecFromText(ratioText: string, widthText: string, heightText: string): AppWindowSpec | undefined {
  const spec: AppWindowSpec = {}
  const ratio = parseWindowRatio(ratioText)
  if (ratio !== null) spec.ratio = ratio
  const width = parsePixelText(widthText)
  if (width !== null) spec.width = width
  const height = parsePixelText(heightText)
  if (height !== null) spec.height = height
  return Object.keys(spec).length === 0 ? undefined : spec
}

/**
 * 像素输入框原文 → 正整数（`""` / 非数字 / 0 ⇒ `null`）。
 * @param raw - 输入框原文。
 * @returns 像素值，或 `null`。
 */
function parsePixelText(raw: string): number | null {
  const text = raw.trim()
  if (text === '' || !/^\d+$/u.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * 这次提交是否**改动了访问范围**（决定要不要二次确认）。
 * @param initial - 表单初值。
 * @param submitted - 本次选中的访问级别。
 * @returns true = 与当前线上值不同（首版发布恒为 false：没有"当前值"）。
 */
export function changesAccess(initial: PublishFormInitial, submitted: AccessMode): boolean {
  return initial.currentAccess !== undefined && initial.currentAccess !== submitted
}

/** 失败：服务端结构化错误**原样**（`details`/`hints` 一字不改）。 */
export interface PublishFailure {
  ok: false
  /** HTTP 状态；null = 请求根本没到达宿主（传输层）。 */
  status: number | null
  code: string
  message: string
  details: unknown
  hints: string[]
  /** true = 传输层失败（网络/被取消），不是服务端裁决。 */
  transport: boolean
}

/** 成功：服务端 `POST …/releases` 的 201 体里 UI 需要的那几个字段。 */
export interface PublishSuccess {
  ok: true
  appId: string
  title: string
  version: string
  /** 服务端 release.status（`approved` / `pending` / …）。 */
  status: string
  /**
   * true = 这个版本**对使用者生效**（既是当前版本，应用也没被下架）。
   *
   * `enabled` 进这个判据是 R1-uxc-1 的修正：旧实现只看 `release.current`/`pending`，
   * 于是一个**已下架**（`enabled=false`，应用子域 410 Gone）的应用发布成功后，
   * 成功块照样写"已生效" —— 界面说的话与线上状态相反。
   */
  live: boolean
  /** true = 进了待审队列（线上仍是旧版本，R17）。 */
  pending: boolean
  /**
   * 应用**当前是否上架**（服务端 `app.enabled`）。
   *
   * 服务端的发布响应**确实**带这个字段（`api/publish.go:682`；已存在应用的
   * `enabled` 保留原值，`:637-639`）—— 旧客户端把它丢掉了，于是"下架应用发新版"
   * 这条路上界面永远是"已生效"。字段缺席时按 `true` 处理（不能凭缺席就宣称
   * 应用已下架；服务端一旦下发就以它为准）。
   */
  enabled: boolean
  /**
   * 2026-09-19（冻结契约 §4.5）：发布响应里**不再有** `entry_url` —— 应用只在客户端
   * 内以 `picoaide-app://<app_id>/` 打开，可分享形态是深链
   * `<渠道 scheme>://app/<app_id>`（客户端按 `app_id` 自己拼，见 `deep-link.ts`）。
   */
  checksum: string
  sizeBytes: number
}

/** 提交过程中的两个可观察阶段（同步 publish 只有"读文件 / 等一次请求"两态，不做假进度条）。 */
export type PublishPhase = 'reading' | 'uploading'

/** 一次本机 JSON 往返的可注入依赖（测试与 UI 共用同一条实现）。 */
export interface RequestDeps {
  fetch?: typeof fetch
  signal?: AbortSignal
}

/** {@link submitPublish} 的可注入依赖。 */
export interface SubmitDeps extends RequestDeps {
  onPhase?: (phase: PublishPhase) => void
}

/** {@link requestJSON} 的结果：成功给解析后的载荷，失败给结构化失败（永不抛）。 */
export type JsonOutcome =
  | { ok: true, status: number, payload: unknown }
  | PublishFailure

/**
 * 发一次本机 JSON 请求并解析（**错误信封的唯一读法**）。
 *
 * 抽出来的理由不是"少写几行"，而是发布与作者生命周期（`app-lifecycle.ts`）两条
 * 链路必须**逐字段同形**地读 `{error:{code,message,details,hints}}`：分开实现的话，
 * 同一次 403 在两个面板上会给出不同的 code/hints，"哪边是对的"就要靠读代码回答。
 *
 * 三条纪律（与旧 `submitPublish` 尾部逐字相同）：
 *  - 非 2xx：解析信封（`.text()` 兜底成 `request failed`），**不丢响应体**；
 *  - 2xx 但不是 JSON：回落 `UNEXPECTED_RESPONSE` + 原文前缀（不假装成功）；
 *  - 传输层失败：`NETWORK_ERROR`（AbortError ⇒ `ABORTED`，`transport: true`）。
 * @param path - 本机路径（`/api/pico/...`）。
 * @param init - method 与可选 body / headers。
 * @param deps - 可注入的 fetch / 取消信号。
 * @returns 成功载荷或结构化失败。
 */
export async function requestJSON(
  path: string,
  init: { method: string, body?: string, headers?: Record<string, string> },
  deps: RequestDeps = {},
): Promise<JsonOutcome> {
  const doFetch = deps.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await doFetch(path, {
      method: init.method,
      ...(init.headers === undefined ? {} : { headers: init.headers }),
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    })
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === 'AbortError'
    return {
      ok: false,
      status: null,
      code: aborted ? 'ABORTED' : 'NETWORK_ERROR',
      message: cause instanceof Error ? cause.message : String(cause),
      details: { url: path },
      hints: aborted
        ? ['已取消本次操作；重发同一条 publish 时宿主会从已收到的分片继续（不会从头再来）']
        : ['确认本机宿主仍在运行（这是本机路由，不是外网请求）'],
      transport: true,
    }
  }
  const text = await response.text().catch(() => '')
  let payload: unknown = null
  try {
    payload = text === '' ? null : JSON.parse(text)
  } catch {
    payload = null
  }
  if (!response.ok) {
    return parseErrorEnvelope(response.status, payload, text.slice(0, 400) !== '' ? text.slice(0, 400) : 'request failed')
  }
  if (payload === null) {
    // 2xx 但不是 JSON：宿主/网关被换掉了（门户 HTML 之类）。原样回显，不假装成功。
    return {
      ok: false,
      status: response.status,
      code: 'UNEXPECTED_RESPONSE',
      message: '本机接口返回的不是 JSON',
      details: { body: text.slice(0, 800) },
      hints: ['检查是否有反向代理把本机路由劫持到了门户页面'],
      transport: false,
    }
  }
  return { ok: true, status: response.status, payload }
}

/**
 * 把白名单文本切成数组：逗号 / 顿号 / 分号 / 换行都算分隔符。
 *
 * 去空白、丢空串、按首次出现顺序去重（服务端 `normalizeWhitelist` 同口径；
 * 这里做的是"别把整行当成一个账号"的输入宽容，不是第二份准入规则）。
 * @param text - 用户输入的白名单文本。
 * @returns 归一化后的账号数组。
 */
export function splitWhitelist(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const piece of text.split(/[,，、;\n\r\t]+/u)) {
    const value = piece.trim()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * Uint8Array → base64。
 *
 * 分片累加（32 KiB/次）而不是 `String.fromCharCode(...bytes)`：后者在 32 MiB 载荷上
 * 会直接撞 `RangeError: Maximum call stack size exceeded`（参数个数上限≈65k）。
 * @param bytes - 原始字节。
 * @returns 标准 base64（无换行、带 `=` 填充）。
 */
export function encodeBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    // `String.fromCharCode(...slice)` 的实参个数 ≤ 32768，安全。
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/**
 * 拼发布请求体（宿主 `/api/pico/apps/wasm/publish` 的入参）。
 *
 * `config` 只发 `access` / `whitelist` / `purpose` / `data_sensitivity` / `owner` 五个字段
 * —— **不发 `visible`**（字段已删除，服务端字段集合封闭，多发即拒）、
 * **不发 `login_required`**（已被 `access` 取代）。
 * 旧字段混进来会让服务端在"未知字段"上拒掉整个发布。
 *
 * 只带非空的可选字段：`title`/`changelog` 留空时**不发**（服务端对空串有自己的回落），
 * 免得把"没填"变成一个看起来像"填了空"的值。
 * @param draft - 表单草稿。
 * @param wasmBase64 - 产物字节（base64）。
 * @returns 请求体对象。
 */
export function buildPublishBody(draft: PublishDraft, wasmBase64: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    app_id: draft.appId.trim(),
    version: draft.version.trim(),
    wasm_base64: wasmBase64,
    config: {
      access: draft.config.access,
      whitelist: [...draft.config.whitelist],
      purpose: draft.config.purpose,
      data_sensitivity: draft.config.dataSensitivity,
      owner: draft.config.owner,
      // 窗口声明（F3/§6）：**只在作者真的声明时**才发这个键 —— 不发等于"不声明"，
      // 而不是"声明了缺省比例"（服务端对缺席有继承语义，客户端不替它写一个值）。
      ...(draft.config.window === undefined ? {} : { window: draft.config.window }),
    },
  }
  if (draft.title.trim() !== '') body.title = draft.title.trim()
  if (draft.changelog.trim() !== '') body.changelog = draft.changelog.trim()
  return body
}

/** 一条预校验问题。`code` 是稳定标识（供测试与 AI 定位），`message` 是给人看的文案。 */
export interface ValidationIssue {
  /** 出问题的字段（`wasm_file` / `app_id` / `version` / `title` / `access` / `whitelist` / …）。 */
  field: string
  /** 稳定问题码（`app_id_shape` / `whitelist_empty` / …）—— 不随文案改动。 */
  code: string
  /** 已本地化的可读文案（当前语言）。 */
  message: string
}

/**
 * 校验选项。
 *
 * `firstRelease` 缺省 `true`：客户端**看不到**服务端的版本历史，无法知道这次是不是首版。
 * 取保守一侧（按首版要求）的理由是首版恰恰是最常见的路径，而漏拦的代价是用户白等一次
 * 90 s 往返后拿到同一句拒绝。服务端仍是裁决者：非首版留空这些字段它**不会**拒。
 */
export interface ValidateOptions {
  firstRelease?: boolean
}

/**
 * 发布表单的**前端预校验**：与 `server/internal/wasmapp/{registry,appcfg}` 同口径。
 *
 * 逐条对应服务端规则（括号里是服务端位置）：
 *  - `app_id` 形态 / 长度 / 纯数字 / `xn--`（`registry.ValidateAppID` + `limits.AppIDPattern`）；
 *  - `version` 形态（`registry.ValidateVersion` + `limits.VersionPattern`）；
 *  - `access` 取值（`appcfg` 的三模式枚举）；
 *  - `access=whitelist` 时名单非空 + 条目数上限（`appcfg.Validate` 的 `empty_whitelist`）；
 *  - 首版 `title`/`purpose`/`data_sensitivity`/`owner` 非空（`appcfg.Validate(true)`）。
 *
 * **只做加法**：这里拦下的一定是服务端也会拒的。不做的事（服务端才知道）：
 * app_id 保留字与企业既有主机名、版本号严格递增、wasm 模块校验。
 * @param draft - 表单草稿。
 * @param options - 校验选项（`firstRelease`，缺省 true）。
 * @returns 问题列表；空数组 = 可以提交（服务端仍可能拒）。
 */
export function validatePublishDraft(draft: PublishDraft, options: ValidateOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const firstRelease = options.firstRelease ?? true
  const appId = draft.appId.trim()
  const version = draft.version.trim()

  if (appId === '') {
    issues.push({ field: 'app_id', code: 'app_id_required', message: t('appCenter.invalidAppIdRequired') })
  } else if (appId.length > APP_ID_MAX_LENGTH) {
    issues.push({ field: 'app_id', code: 'app_id_length', message: t('appCenter.invalidAppIdLength') })
  } else if (appId.startsWith(APP_ID_PUNYCODE_PREFIX)) {
    // 先于形态检查：任何 `xn--` 开头的串都过不了形态正则（`-` 后必须跟字母数字），
    // 但"punycode 前缀保留给国际化域名"比"含非法字符"更能让人知道该改什么。
    issues.push({ field: 'app_id', code: 'app_id_punycode', message: t('appCenter.invalidAppIdPunycode') })
  } else if (!APP_ID_PATTERN.test(appId)) {
    issues.push({ field: 'app_id', code: 'app_id_shape', message: t('appCenter.invalidAppIdShape') })
  } else if (APP_ID_ALL_DIGITS_PATTERN.test(appId)) {
    issues.push({ field: 'app_id', code: 'app_id_numeric', message: t('appCenter.invalidAppIdNumeric') })
  }

  if (version === '') {
    issues.push({ field: 'version', code: 'version_required', message: t('appCenter.invalidVersionRequired') })
  } else if (!VERSION_PATTERN.test(version)) {
    issues.push({ field: 'version', code: 'version_shape', message: t('appCenter.invalidVersionShape') })
  }

  // 2026-09-19（冻结契约 §4.4）：写侧只接受 login | whitelist。历史 `public` 由**读侧**
  // 当作 login（存量应用不会被拒绝），但新版本不得再写它 —— 本地预校验与服务端同一集合。
  if (!(WRITABLE_ACCESS_MODES as readonly string[]).includes(draft.config.access)) {
    issues.push({ field: 'access', code: 'access_invalid', message: t('appCenter.invalidAccess') })
  }

  // 窗口声明（F3/§6）：只有**填了**才校验；越界/非数字 ⇒ 本地拦下（服务端同一区间）。
  const ratioRaw = draft.config.window?.ratio
  if (ratioRaw !== undefined && parseWindowRatio(ratioRaw) === null) {
    issues.push({ field: 'window.ratio', code: 'window_ratio_invalid', message: t('appCenter.invalidWindowRatio') })
  }
  for (const [field, value] of [['window.width', draft.config.window?.width], ['window.height', draft.config.window?.height]] as const) {
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      issues.push({ field, code: 'window_size_invalid', message: t('appCenter.invalidWindowSize') })
    }
  }

  // whitelist 的两条只在"选了白名单模式"或"填了名单"时才有意义：
  // 选了别的模式却留着名单是允许的（服务端不比对，名单只是给应用自己读的备份）。
  if (draft.config.access === 'whitelist') {
    if (draft.config.whitelist.length === 0) {
      issues.push({ field: 'whitelist', code: 'whitelist_empty', message: t('appCenter.invalidWhitelistEmpty') })
    } else if (draft.config.whitelist.length > WHITELIST_MAX) {
      issues.push({ field: 'whitelist', code: 'whitelist_too_many', message: t('appCenter.invalidWhitelistTooMany') })
    }
  }

  if (firstRelease) {
    if (draft.title.trim() === '') {
      issues.push({ field: 'title', code: 'title_required', message: t('appCenter.requiredTitle') })
    }
    if (draft.config.purpose.trim() === '') {
      issues.push({ field: 'purpose', code: 'purpose_required', message: t('appCenter.requiredPurpose') })
    }
    if (draft.config.dataSensitivity.trim() === '') {
      issues.push({ field: 'data_sensitivity', code: 'data_sensitivity_required', message: t('appCenter.requiredDataSensitivity') })
    }
    if (draft.config.owner.trim() === '') {
      issues.push({ field: 'owner', code: 'owner_required', message: t('appCenter.requiredOwner') })
    }
  }

  return issues
}

/**
 * 解析服务端错误信封。**不裁剪、不改写**：`code`/`message`/`details`/`hints` 全带上，
 * 缺字段时回落成"能读的替代值"而不是空串（UI 与 AI 都要有东西可看）。
 * @param status - HTTP 状态；null = 传输层失败。
 * @param payload - 解析后的响应体（可能为 null：非 JSON）。
 * @param fallbackMessage - 完全没有可读信息时的兜底文案。
 * @returns 结构化失败对象。
 */
export function parseErrorEnvelope(
  status: number | null,
  payload: unknown,
  fallbackMessage = 'request failed',
): PublishFailure {
  const root = (payload ?? {}) as Record<string, unknown>
  const error = (root.error ?? {}) as Record<string, unknown>
  const code = typeof error.code === 'string' && error.code !== ''
    ? error.code
    : status === null ? 'NETWORK_ERROR' : `HTTP_${String(status)}`
  const message = typeof error.message === 'string' && error.message !== ''
    ? error.message
    : fallbackMessage
  const details = Object.hasOwn(error, 'details') ? error.details : undefined
  const hints = Array.isArray(error.hints)
    ? error.hints.filter((hint): hint is string => typeof hint === 'string' && hint !== '')
    : []
  return { ok: false, status, code, message, details, hints, transport: status === null }
}

/**
 * 解析成功响应（服务端 `publish.go:670-690` 的 `{app, release, review_required}`）。
 *
 * 形状不对（缺 `release.version`）时**不假装成功**：回落成结构化失败并把原始体放进
 * `details`，这样"服务端改了下发形状"会立刻被看见，而不是显示一个空白的成功页。
 *
 * **`app.enabled` 必须接住**（R1-uxc-1）：服务端下发它（`publish.go:682`），而旧实现
 * 只取 `app_id`/`title`/`entry_url` —— 于是"已下架应用发新版"成功块写"已生效"，
 * 而应用仍是下架状态。`entry_url` 自 2026-09-19 起**已不存在**（冻结契约 §4.5），
 * 这里也不再读它。
 * @param payload - 解析后的响应体。
 * @returns 成功对象，或结构化失败。
 */
export function parsePublishOutcome(payload: unknown): PublishSuccess | PublishFailure {
  const root = (payload ?? {}) as Record<string, unknown>
  const app = (root.app ?? {}) as Record<string, unknown>
  const release = (root.release ?? {}) as Record<string, unknown>
  const version = typeof release.version === 'string' ? release.version : ''
  if (version === '') {
    return {
      ok: false,
      status: 200,
      code: 'UNEXPECTED_RESPONSE',
      message: '服务端没有返回版本号（发布响应形状与客户端预期不一致）',
      details: { response: payload },
      hints: ['把 details.response 交给平台维护者：这通常意味着服务端刚改了发布响应'],
      transport: false,
    }
  }
  const pending = root.review_required === true || release.status === 'pending'
  // `app.enabled` 是服务端下发的事实（下架应用发新版时它保持 false）。
  // 缺席 ⇒ true：不能因为服务端没说话就宣称应用已下架（本仓"缺席不等于否定"的口径）。
  const enabled = app.enabled !== false
  return {
    ok: true,
    appId: typeof app.app_id === 'string' ? app.app_id : '',
    title: typeof app.title === 'string' ? app.title : '',
    version,
    status: typeof release.status === 'string' ? release.status : '',
    live: (release.current === true || !pending) && enabled,
    pending,
    enabled,
    checksum: typeof release.checksum === 'string' ? release.checksum : '',
    sizeBytes: typeof release.size === 'number' ? release.size : 0,
  }
}

/**
 * 标识查重入口（宿主只读代理 → 服务端 `GET /apps/wasm/:app_id/availability`）。
 *
 * 为什么是**独立端点**而不是复用目录（`catalog`）：目录**故意**不列冻结应用、也不列
 * "占名但从未发布成功"的行，而这两类都实打实占着标识。拿目录当唯一性判据会给出
 * "这个标识没人用"的**反向**结论 —— 用户填完一整个包才在最后一步拿到 409。
 * @see {@link checkAppIdAvailability}
 */
export const AVAILABILITY_PATH = '/api/pico/apps/wasm'

/** 标识查重结论（服务端 `availability` 的字段子集；字段名是跨端契约）。 */
export interface AppIdAvailability {
  /** 服务端回显的标识（未归一化：`My-Tool` 会原样回）。 */
  appId: string
  /** 形态是否合法（平台规则：小写/长度/保留字/纯数字/punycode 前缀）。 */
  valid: boolean
  /** 标识是否已被占用（**含**冻结、下架、软删的占名行）。 */
  exists: boolean
  /** 能否用它**发首版**（= 未被占用）。 */
  available: boolean
  /** 严格归属：这一行是不是登记在你名下（管理员接管时仍为 false）。 */
  ownedByYou: boolean
  /** 能否对这个标识**发布**（本人的应用，或管理员的兜底接管）。 */
  canPublish: boolean
  /** 判词：available / yours / taken / invalid。 */
  reason: 'available' | 'yours' | 'taken' | 'invalid'
  /** 非 available 时的稳定错误码（`NAME_TAKEN` / `INVALID_APP_ID`），与发布路径同码。 */
  code: string
  /** 可读原因（服务端原文，客户端不改写）。 */
  message: string
  /** 可操作提示（服务端原文）。 */
  hints: string[]
}

/** {@link checkAppIdAvailability} 的结果：成功给判词，失败给结构化失败。 */
export type AvailabilityOutcome =
  | { ok: true, availability: AppIdAvailability }
  | PublishFailure

/**
 * 解析标识查重载荷。**fail-closed**：判词字段认不出来就返回 `null`（调用方据此
 * 判定为"查重不可用"），绝不默认成"可用"—— 那会让表单放行一次注定失败的发布。
 * @param payload - 服务端响应体。
 * @returns 判词，或 `null`（形状不认识）。
 */
export function parseAvailability(payload: unknown): AppIdAvailability | null {
  if (typeof payload !== 'object' || payload === null) return null
  const raw = payload as Record<string, unknown>
  const reason = raw.reason
  if (reason !== 'available' && reason !== 'yours' && reason !== 'taken' && reason !== 'invalid') return null
  return {
    appId: typeof raw.app_id === 'string' ? raw.app_id : '',
    valid: raw.valid === true,
    exists: raw.exists === true,
    available: raw.available === true,
    ownedByYou: raw.owned_by_you === true,
    canPublish: raw.can_publish === true,
    reason,
    code: typeof raw.code === 'string' ? raw.code : '',
    message: typeof raw.message === 'string' ? raw.message : '',
    hints: Array.isArray(raw.hints) ? raw.hints.filter((h): h is string => typeof h === 'string') : [],
  }
}

/**
 * 问服务端"这个 app_id 现在能不能用"。
 *
 * 只读、便宜、可重复：服务端不编译、不写盘、不占版本号、不进审计、不消耗上传额度。
 * 因此它适合"用户每敲几个字问一次 + 提交前再问一次"。
 *
 * ⚠️ **它是体验优化，不是权威判据**：权威永远是发布那一刻服务端的 `NAME_TAKEN`。
 * 两次调用之间别人可能抢注同名，所以调用方**不得**把"这里说可用"当成发布一定成功；
 * 反过来，"这里说被占用"才是可以据此拦下提交的正面证据。
 * @param appId - 用户输入的标识（原值；服务端按原值判形态，不做静默小写）。
 * @param deps - 可注入的 fetch / 取消信号。
 * @returns 判词或结构化失败（永不抛异常）。
 */
export async function checkAppIdAvailability(
  appId: string,
  deps: RequestDeps = {},
): Promise<AvailabilityOutcome> {
  const trimmed = appId.trim()
  if (trimmed === '') {
    // 空串不发请求：表单本来就不该在没填的时候问服务端。这里给出一个与本地预校验
    // **同码同文案**的判词，调用方不必为"空输入"再写一个分支。
    return {
      ok: true,
      availability: {
        appId: '',
        valid: false,
        exists: false,
        available: false,
        ownedByYou: false,
        canPublish: false,
        reason: 'invalid',
        code: 'app_id_required',
        message: t('appCenter.invalidAppIdRequired'),
        hints: [],
      },
    }
  }
  // app_id 只用 [a-z0-9-]，本不需要百分号编码；仍然编一次是因为**形态非法**的输入
  // （用户还没改完就触发防抖）也要能安全地送到服务端换回一句"必须全小写"，
  // 而不是在 URL 拼接处炸掉。
  const outcome = await requestJSON(
    `${AVAILABILITY_PATH}/${encodeURIComponent(trimmed)}/availability`,
    { method: 'GET' },
    deps,
  )
  if (!outcome.ok) return outcome
  const availability = parseAvailability(outcome.payload)
  if (availability === null) {
    return {
      ok: false,
      status: outcome.status,
      code: 'UNEXPECTED_RESPONSE',
      message: t('appCenter.availabilityShapeMismatch'),
      details: { payload: outcome.payload },
      hints: [t('appCenter.availabilityShapeHint')],
      transport: false,
    }
  }
  return { ok: true, availability }
}

/**
 * 提交一次发布：读文件 → base64 → `POST /api/pico/apps/wasm/publish` → 解析结果。
 *
 * 分片与 90 s 预算**不在这里**：那是宿主 `/publish` 的编排（`base64 > 8 MiB` 自动分片、
 * 断线续传）。本函数只负责"页面这一侧"的一次 fetch —— 复制一份分片逻辑等于制造第二个
 * 契约，迟早与服务端漂移（这正是 FIX-43 的教训）。
 * @param draft - 表单草稿。
 * @param file - 已选择的产物。
 * @param deps - 可注入的 fetch / 取消信号 / 阶段回调。
 * @returns 成功或**结构化**失败（永不抛异常：UI 必须总能显示点什么）。
 */
export async function submitPublish(
  draft: PublishDraft,
  file: PublishFile,
  deps: SubmitDeps = {},
): Promise<PublishSuccess | PublishFailure> {
  deps.onPhase?.('reading')
  let wasmBase64: string
  try {
    wasmBase64 = encodeBase64(file.bytes)
  } catch (cause) {
    return {
      ok: false,
      status: null,
      code: 'FILE_READ_FAILED',
      message: cause instanceof Error ? cause.message : String(cause),
      details: { file: file.name, size_bytes: file.bytes.byteLength },
      hints: ['重新选择文件；若文件在别处被改写，请重新编译后再发布'],
      transport: false,
    }
  }
  deps.onPhase?.('uploading')
  // 一次往返（含错误信封读法）走**共享**实现：作者生命周期（app-lifecycle.ts）用的是
  // 同一个 `requestJSON`，两条链路不会给出两套 code/hints 读法。
  const outcome = await requestJSON(PUBLISH_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPublishBody(draft, wasmBase64)),
  }, deps)
  if (!outcome.ok) return outcome
  return parsePublishOutcome(outcome.payload)
}
