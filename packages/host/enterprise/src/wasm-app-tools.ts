/**
 * WASM 应用平台的**宿主工具面**：让 AI 能列出目录、预检、发布
 * （设计基线 `docs/planning/2026-09-17-wasm-app-platform.md` §6.5b 的最小工具集）。
 *
 * ## 为什么是工具而不是 curl
 *
 * 员工令牌只存在于 Host（`ctx.picoSession`）的内存里（红线 3：应用与 AI 都拿不到）。
 * 所以 AI 有两条路都走不通：直连服务端（没有令牌）、打本机写面（要求浏览器持有性
 * 证明，而 AI 的 bash/curl 拿不到那张票）。工具在宿主进程内执行，直接调用与本地路由
 * **同一批编排函数**（`wasm-apps.ts` 的 `publishApp` / `validateApp` / `listCatalog`），
 * 令牌只在本进程内被用作 `Authorization` 头，**既不打印也不返回**。
 *
 * ## publisher 语义（设计 §8 / F-52b）
 *
 * 「AI 只是编辑器，`publisher` 记发起操作的员工」：工具用的就是**当前登录员工的
 * 会话令牌**，服务端据此记录归属与审计 —— 因此"谁让 AI 发的，就记谁"。这里
 * **不得**引入任何共享账号 / 服务账号 / 高权限代发路径：一旦引入，全部应用都会归到
 * 同一个账号上，"发布者即管理者"的权限模型立刻失效。未登录时工具直接拒绝，
 * 绝不会退化成"用别人的身份发"。
 *
 * ## 契约
 *
 *  - 参数描述是**模型可见契约**（中文，与 cron/browser 的工具面一致）：每个字段都
 *    写清必填/形态/约束，让模型不必靠试错就能填对。
 *  - 结果里**原样带出**服务端业务错误信封的 `code`/`message`/`details`/`hints`
 *    （§8：第一消费者是 AI，丢掉 hints 等于让它自己猜）。
 *  - 出站预算 ≥ 90 s（{@link WASM_APP_TOOL_TIMEOUT_MS} 严格大于
 *    `CLIENT_UPLOAD_TIMEOUT_MS`）：服务端 publish 是同步的、含最长 60 s 编译，
 *    工具 deadline 若短于出站预算，模型只会看到一句笼统的 tool timeout
 *    （本仓已有"闸门 + 余量 < 工具预算"的教训，见 2026-09-16 浏览器用户闸诊断）。
 *
 * @module @picoaide/dsh-enterprise/wasm-app-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { hostCopy, type HostLocale } from 'dsh-plugin-desktop/host-locale'
import { APP_BUILDER_SKILL, builtinSkillInstallHint, isBuiltinSkillInstalled } from './builtin-skills.ts'
import type { Session } from './server-connector/config.ts'
import type { AiRowsConsentStore } from './wasm-apps-ai-rows-consent.ts'
import {
  CLIENT_UPLOAD_TIMEOUT_MS,
  errorEnvelopeOf,
  listCatalog,
  parseWasmBody,
  publishApp,
  readAppDiagnostics,
  readAppRows,
  readAppSchema,
  validateApp,
  wasmError,
  type WasmResponse,
} from './wasm-apps.ts'

/**
 * 工具面的注册结果（`.name` 的集合即模型可见的工具清单）。
 *
 * 三个名字只在这里出现一次：注册与测试断言共用同一份真源（写死两处的话，
 * "工具改名了但测试还在断言旧名字"会静默通过）。
 */
export const WASM_APP_TOOL_NAMES = [
  'wasm_app_list',
  'wasm_app_validate',
  'wasm_app_publish',
  // 回读面（2026-09-21）：作者排障闭环的另一半。此前 AI 只能"写"不能"看"，
  // 而技能文档却要求它"先读诊断，再改代码" —— 那条链路上根本没有工具。
  'wasm_app_schema',
  'wasm_app_diagnostics',
  'wasm_app_rows',
] as const

/**
 * 工具的单次预算：120 s。
 *
 * **必须严格大于** {@link CLIENT_UPLOAD_TIMEOUT_MS}（90 s，§4.2）：先由出站预算
 * 到点 abort，模型才能拿到带 `GATEWAY_TIMEOUT` + hints 的**结构化**结果；
 * 反过来（工具先到点）结果会被上游超时策略整条替换成 `tool call timed out`，
 * 里面的诊断信息一个字都送不到模型。
 */
export const WASM_APP_TOOL_TIMEOUT_MS = 120_000

// ---------------------------------------------------------------------------
// 配置字段规格（`picoaide.app.json`）
// ---------------------------------------------------------------------------
//
// **单一真源** = 服务端生成的机器可读字段表
// `server/internal/wasmapp/appcfg/appcfg.json`（由服务端侧生成）。
// 下面这几个常量是它在宿主工具侧的镜像，由 `tests/wasm-app-tools.spec.ts` 里
// 一条**读那份 JSON 逐项对拍**的用例钉住：字段集合与首版必填标志一旦漂移即红
// （文件还不存在时该用例 skip 并打印原因，不假绿）。
//
// 为什么不 import：跨包 import 服务端 Go 包的产物不在任何 package exports 里，
// 运行期解析不可靠；而工具的参数 schema 必须是编译期常量（`defineTool` 要它做
// 类型推导）。客户端面板另有一份镜像（`@picoaide/dsh-wasm-apps` 的
// `appcfg-contract.ts`），同样对拍那份 JSON —— 三处都指向同一个真源。

/** `picoaide.app.json` 的**封闭**字段集合（多一个未知字段服务端即拒）。 */
export const APP_CONFIG_FIELDS = ['access', 'whitelist', 'purpose', 'data_sensitivity', 'owner', 'window', 'sensitive_columns'] as const

/** `picoaide.app.json` 的字段名类型。 */
export type AppConfigField = (typeof APP_CONFIG_FIELDS)[number]

/**
 * **首版必填**的声明字段（服务端 `appcfg.Validate(firstRelease=true)`）。
 *
 * `title` 不在这张表里：它是发布载荷字段而不是配置文件字段（`title` 的首版必填
 * 由服务端 `publish.go` 单独判定，工具面把它标成必填参数）。
 */
export const APP_CONFIG_FIRST_RELEASE_REQUIRED = ['purpose', 'data_sensitivity', 'owner'] as const

/**
 * `access` 的**可写**取值（与帧内 `auth.mode` 同一套，§7.1）。
 *
 * ⚠️ 2026-09-20 修正：这里原来写的是三值 `['public','login','whitelist']` —— 与真源
 * 冲突。服务端 `appcfg` 的 `access_values` 只有 **login / whitelist**（缺省 login），
 * `public` 是**历史只读值**（读取侧等同 login），**写侧一律拒**
 * （`APP_CONFIG_INVALID` + `details.reason="public_not_allowed"`，文案
 * 「access="public" 不再可用：应用只在桌面客户端内，且一律要求登录」）。
 *
 * 这份常量是**模型可见**的工具参数描述，写错会让模型主动产出一个必然被拒的发布
 * —— 属于活契约，必须与 `server/internal/wasmapp/appcfg/appcfg.json` 对拍
 * （守卫见 `tests/wasm-app-tools.spec.ts` 的"access 取值与 appcfg.json 真源一致"）。
 */
export const APP_CONFIG_ACCESS_MODES = ['login', 'whitelist'] as const

/** `access` 的缺省值：`login`（写漏不该让应用意外变成匿名可达）。 */
export const APP_CONFIG_DEFAULT_ACCESS = 'login'

/** 每个配置字段的说明（模型可见；测试断言每个字段都有非空说明）。 */
export const APP_CONFIG_FIELD_DESCRIPTIONS: Record<AppConfigField, string> = {
  access: '访问模式，二选一：login = 登录后全员可用（**缺省**，拿不准就填它）；whitelist = 仅名单内用户可用（平台只把登录身份交给应用，名单由应用自己比对）。历史值 public（匿名可用）**已不再可用**，写它会发布失败。',
  whitelist: '准入名单：手填的账号列表（用户名或用户 ID），access=whitelist 时**必须非空**（空名单意味着对所有人不可用，服务端会拒）。平台**不校验**账号是否存在（避免变成账号枚举接口），也不提供员工名录；上限 2000 条。改名单 = 发一个新版本。',
  purpose: '一句话用途声明（首版必填）：这个应用做什么、给谁用。会显示在应用中心。',
  data_sensitivity: '数据敏感度声明（首版必填）：例如「公开」「内部」「敏感」。写给管理员看的一行。',
  owner: '负责人声明（首版必填）：出问题找谁（姓名 / 工号 / 账号）。**这不是平台归属**——平台归属取自登录态（谁发布就是谁的），不可伪造。',
  sensitive_columns: '作者**显式声明**的敏感列名（可选，缺省不声明）：这里列出的列在作者数据面（`wasm_app_rows` / 客户端「数据」面板）**一定**按敏感处理（显示 ***），即使列名不在平台的启发式名单里。与启发式取并集（声明只会更严，不会让某列变得可见）；上限 100 条、单条 ≤64 字节、大小写不敏感去重，越界 ⇒ 发布期 APP_CONFIG_INVALID。整个字段缺席 = 沿用上一版生效值；显式给空数组 = 本版不声明。原值仍只能由人在面板里显式查看（AI 工具面永远拿不到原值）。',
  window: '窗口的默认尺寸与强制宽高比。`window.ratio` 是客户端 resize 时锁定的比例（"W:H" 或浮点，合法区间 0.25–4.0，越界 ⇒ 发布期 APP_CONFIG_INVALID）；`window.width` / `window.height` 是首次打开的默认尺寸（缺省 1280×720，写了 ratio 时按比例校正）。未知子键（如 window.zoom）会被拒；整个 window 缺席 = 沿用上一版生效值。',
}

/**
 * `config` 参数的字段 schema：字段名来自 {@link APP_CONFIG_FIELDS}，首版必填标志
 * 来自 {@link APP_CONFIG_FIRST_RELEASE_REQUIRED}（两者都是常量，测试对拍）。
 *
 * 说明为什么标成"必填"而不是"首版必填"：JSON Schema 表达不了"仅首版必填"。
 * 取严格一侧（始终要求这三个声明）的代价是更新版本时要多写三行，收益是
 * **声明永远不会因为漏填而被服务端判成"空"**——而这三行本来就写在应用的
 * `picoaide.app.json` 里，模型手上就有。
 */
const APP_CONFIG_PROPERTIES = {
  access: {
    type: 'string',
    enum: APP_CONFIG_ACCESS_MODES,
    description: APP_CONFIG_FIELD_DESCRIPTIONS.access,
  },
  whitelist: {
    type: 'array',
    items: { type: 'string' },
    description: APP_CONFIG_FIELD_DESCRIPTIONS.whitelist,
  },
  purpose: {
    type: 'string',
    required: true,
    description: APP_CONFIG_FIELD_DESCRIPTIONS.purpose,
  },
  data_sensitivity: {
    type: 'string',
    required: true,
    description: APP_CONFIG_FIELD_DESCRIPTIONS.data_sensitivity,
  },
  owner: {
    type: 'string',
    required: true,
    description: APP_CONFIG_FIELD_DESCRIPTIONS.owner,
  },
  // §6 / appcfg.json 的 `window`（R2-S-2）：可选整体对象，未知子键服务端拒。
  sensitive_columns: {
    type: 'array',
    items: { type: 'string' },
    description: APP_CONFIG_FIELD_DESCRIPTIONS.sensitive_columns,
  },
  window: {
    type: 'object',
    // 未知子键服务端会拒（`window.zoom` 这类），所以这里也封闭。
    additionalProperties: false,
    description: APP_CONFIG_FIELD_DESCRIPTIONS.window,
    properties: {
      ratio: { type: 'string', description: '强制锁定的宽高比（"W:H" 或浮点，合法区间 0.25–4.0）。' },
      width: { type: 'integer', description: '首次打开的默认宽度（像素；缺省 1280，写了 ratio 时按比例校正）。' },
      height: { type: 'integer', description: '首次打开的默认高度（像素；缺省 720，写了 ratio 时按比例校正）。' },
    },
  },
} as const

/** `config` 参数的说明（发布必填；字段集合封闭：多一个未知字段服务端即拒）。 */
const APP_CONFIG_DESCRIPTION = [
  '应用配置声明（`picoaide.app.json` 的内容；**发布必填**，服务端字段表里 `config` 就是必填项）。',
  '字段集合是**封闭**的：access / whitelist / purpose / data_sensitivity / owner —— ',
  '多一个**未知**字段服务端会直接拒。',
  '旧 schema 的 visible / login_required 是**兼容形态**，但它们**不参与"字段是否缺席"的判定**：',
  '既有生效版本时，带了它们也照样从上一版沿用 access/whitelist（它们既不算 access 的显式声明，也不会关掉继承），',
  '只有首版（没有可沿用的上一版）才按兼容表映射。所以新版一律不要发它们：发它们不会改变访问级别，',
  '只会让"这次改了什么"读不出来。',
  '首次发布时 purpose / data_sensitivity / owner 三个声明缺一不可；更新版本时可以省略未改动的（服务端沿用原值），',
  '但要改访问方式或名单就必须给全五个字段。注意**改配置 = 发新版本**，运行期改不了。',
  '沿用只发生在"上一版生效配置读得出来"时：若它在平台侧是坏行，服务端会**拒绝发布**',
  '（APP_CONFIG_INVALID / details.reason=baseline_unusable）并点名是哪一版 —— 那是平台数据问题，',
  '改本机产物没有用，按 hints 让管理员修复那一行后再发（绝不会静默改掉访问级别）。',
].join('')

/** `config` 参数的说明（validate 的可选形态：预检时带上会一起校验）。 */
const APP_CONFIG_DESCRIPTION_OPTIONAL = [
  '可选：应用配置声明（`picoaide.app.json` 的内容）。',
  '预检时带上它会**一起校验**：access 取值、access=whitelist 时的名单是否为空、首版三个声明是否齐全都能提前发现。',
  '字段集合是**封闭**的：access / whitelist / purpose / data_sensitivity / owner —— 多一个**未知**字段服务端会直接拒；',
  '旧 schema 的 visible / login_required 不参与"字段是否缺席"的判定（既有生效版本时照样沿用上一版的 access/whitelist），',
  '只有首版才按兼容表映射，但新版不要发它们。',
  '上一版生效配置在平台侧读不出来时，预检与发布都会拒绝（details.reason=baseline_unusable）——',
  '不是让你改 config，而是平台数据需要管理员修复。',
].join('')

// ---------------------------------------------------------------------------
// 参数描述（模型可见契约）
// ---------------------------------------------------------------------------

/** `appId` 的形态规则（与 `limits.AppIDPattern`、服务端 `registry.ValidateAppID` 同口径）。 */
const APP_ID_DESCRIPTION = [
  '应用标识（app_id），同时也是它的域名标签：应用地址是 https://<app_id>.<企业域名>。',
  '形态：小写字母/数字，用单个连字符分段（正则 ^[a-z0-9]+(?:-[a-z0-9]+)*$），不超过 63 个字符，',
  '不能是纯数字，不能以 xn-- 开头，不能用平台保留字（www / api / admin / portal / updates / sso / login 等）。',
  '**一经发布不能改名**；首个发布者永久占用该标识（删除、下架也还是他的）。',
  '先用 wasm_app_list 看看有没有被占用。',
].join('')

/** `version` 的形态与递增规则。 */
const VERSION_DESCRIPTION = [
  '新版本号，形如 x.y.z（可带 -prerelease 后缀，正则 ^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?$），',
  '并且必须**严格大于**该应用当前的线上版本（服务端拒绝回退与重复；先用 wasm_app_list 查当前版本）。',
  '首次发布任意合法版本号都可以（建议 1.0.0）。**失败的发布不占版本号**，可以拿同一个号重发。',
].join('')

/** `wasmPath` 的读取面与体积约束（FIX-39/FIX-41 的收敛结果）。 */
const WASM_PATH_DESCRIPTION = [
  '本机编译产物（.wasm 文件）的**绝对路径**，例如 /workspace/shared-notes/main.wasm。',
  '约束：必须是**普通文件**（不能是目录 / 设备 / 管道）；必须位于**已登记的工作区**内（本会话或同机其它已登记工作区）或数据根的 apps 目录下',
  '（其它位置一律拒绝 —— 包括数据根里的凭据文件与数据根之外的任何目录，这是安全边界不是可调配置）；文件不超过 32 MiB。',
  '大于 8 MiB 的产物由宿主自动分片上传并在断线后只补缺失分片，调用方不需要特殊处理。',
  '产物要在会话工作区内编译（见 skill 的黄金路径：GOCACHE/GOMODCACHE/GOPATH/TMPDIR 都指向工作区）。',
].join('')

/** `title` 的必填规则。 */
const TITLE_DESCRIPTION = [
  '应用标题：显示在应用中心的名字，例如「共享便签」（首版必填）。',
  '更新已有应用时也请照填（与上次一致即可）：服务端在缺省时会沿用现有标题，但显式给出才不会把标题写歪。',
].join('')

/** `changelog` 的必填规则（**非首版必填**是模型最容易漏的一条）。 */
const CHANGELOG_DESCRIPTION = [
  '本次更新说明（**非首版必填**：给已有应用发新版本时必须写，首版可以省略）。',
  '写给使用者看的一句话，例如「修复了名单校验」「新增导出按钮」。',
].join('')

/** `uploadId` 的续传用法（配合 UPLOAD_INCOMPLETE 的 details.upload_id）。 */
const UPLOAD_ID_DESCRIPTION = [
  '分片上传会话 id：**只在断线续传时填**。',
  '上一次 publish 返回 UPLOAD_INCOMPLETE 时，把它 error.details.upload_id 的值原样填进来，',
  '宿主就只会补传缺失的分片（会话 TTL 内有效）；不填则重新开一次上传会话，已传的片不会复用。',
].join('')

/** 频率闸门的说明（validate 与 publish 共用一条额度）。 */
const RATE_LIMIT_DESCRIPTION = '预检与发布**合计**每人每小时 30 次，同一时刻只允许 1 个编译中的上传。拿到 RATE_LIMITED / COMPILE_BUSY 时按 hints 等一会儿再试，不要连续重试。'

/**
 * 作者手册的指路（写面工具的说明里**常驻**一句）。
 *
 * 用户要求「skill 内置到服务端、客户端按需安装」：技能是随需的，模型不能假设它
 * 一定在本机。写清这条，模型在第一次失败时就知道该让用户去装，而不是反复重试
 * 或改用 curl（那条路走不通，见模块头注释）。
 */
const SKILL_POINTER = `写代码/编译产物遇到问题时，本机应装有平台内置的作者手册技能 ${APP_BUILDER_SKILL}（客户端「能力中心 → 平台内置技能」一键安装，服务端随镜像下发）：里面是导入面清单、字段表与编译黄金路径。若未安装，工具报错时会给出安装指路。`

// ---------------------------------------------------------------------------
// 内置作者手册的指路
// ---------------------------------------------------------------------------

/**
 * 哪些失败值得附上「先装作者手册」。
 *
 * 判据是「**作者写的东西**不对」——手册里是导入面清单、配置字段表与编译黄金路径，
 * 只有这类失败它救得了。**认不出业务信封时一律不附**（上游根本不是本服务端在说话）。
 * 四类**不附**：
 *
 *   - **身份**（401/403）：未登录 / 审计账号只读 / 越权，装手册解决不了；
 *   - **传输**（`GATEWAY_*`）：网络不可达或出站超时。附指路会把模型引向
 *     「去装技能」这种与故障无关的动作（独立审计 2026-09-18 P2-2 复现的正是这条）；
 *   - **本地前置闸门**（`WASM_PATH_*` / `UPLOAD_*` / `MISSING_FIELD` /
 *     `INVALID_JSON`）：产物压根没送到服务端，问题是路径、参数或分片会话；
 *   - **平台侧的"现在别来"**（`RATE_LIMITED` / `COMPILE_BUSY`）：等服务端腾出来
 *     就行，不是作者要改东西（独立验证 2026-09-18 P3-2）。
 *
 * 其余（服务端业务错误：导入面、段表、体积、配置字段、`COMPILE_TIMEOUT`/`COMPILE_OOM`
 * 这类"产物本身有问题/太大"、编译失败…）一律附上。
 * @param status - 上游或本地状态码。
 * @param code - 错误信封里的 `code`；**认不出信封时必须省略**（见上：不附指路）。
 * @returns 该失败是否附加指路。
 */
export function skillHintAppliesTo(status: number, code?: string): boolean {
  if (status < 400 || status === 401 || status === 403) return false
  // 没有 code = 认不出业务信封（反代 HTML / 空 body / 被劫持的响应）⇒ 不指路。
  if (code === undefined) return false
  if (code.startsWith('GATEWAY_')) return false
  if (code.startsWith('WASM_PATH_') || code.startsWith('UPLOAD_')) return false
  return code !== 'MISSING_FIELD' && code !== 'INVALID_JSON'
    && code !== 'RATE_LIMITED' && code !== 'COMPILE_BUSY'
}

/**
 * 内置作者手册**没装**时给出指路，装了则返回 `null`。
 *
 * 每次调用都重新判定磁盘事实（用户可以在会话中途装上，模块级冻结会把"已经装好了"
 * 一直报成"没装"——本仓对宿主侧语言/状态有过同类教训）。
 * @param locale - 宿主语言（按调用解析）。
 * @returns 指路文案，或 null（已装 / 无需提示）。
 */
export async function resolveSkillHint(locale: HostLocale): Promise<string | null> {
  return (await isBuiltinSkillInstalled()) ? null : builtinSkillInstallHint(locale)
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

/** 工具面的宿主依赖。 */
export interface WasmAppToolOptions {
  /**
   * 宿主语言（**每次调用**解析，禁止模块级冻结）。
   *
   * 与 cron/browser 同款：用户可以在应用运行中切换语言，而工具结果是在插件
   * apply 之后很久才渲染的 —— 模块级常量会把语言钉死在导入那一刻。
   */
  locale: () => HostLocale
  /**
   * 「允许 AI 读取此应用的数据」的**授权状态**（2026-09-21 用户拍板：默认关）。
   *
   * 必须是**与本机路由同一个实例**（`auth-gate.ts` 里创建一次、两处共用）：
   * 面板写它、`wasm_app_rows` 读它，两个实例就会出现"点了允许但工具仍拒绝"。
   * 缺省（最小组合/单测）⇒ 一份内存记录 = 谁都没授权（fail-closed）。
   */
  aiRowsConsent?: AiRowsConsentStore
}

/** 授权状态缺省实现：内存记录，永远"未授权"（fail-closed，且不假装记得住）。 */
const DENY_ALL_AI_ROWS: AiRowsConsentStore = {
  isEnabled: () => Promise.resolve(false),
  setEnabled: () => Promise.resolve(),
}

/**
 * 「AI 读行数据还没有被授权」的**稳定错误码**（跨端契约：客户端面板与技能文档都按它
 * 解释"为什么工具拒绝了"）。写死两处会让改名静默通过，所以注册与判据共用这一个常量。
 */
export const AI_ROWS_NOT_AUTHORIZED = 'AI_ROWS_NOT_AUTHORIZED'

/**
 * 「AI 读行数据还没有被授权」的**结构化拒绝**（稳定 code：`AI_ROWS_NOT_AUTHORIZED`）。
 *
 * 为什么必须是拒绝而不是空结果：空结果（`{rows:[]}`）会让模型把"人还没授权"读成
 * "这张表是空的 / 数据没写进去"，于是它会去改代码 —— 方向完全错。这里给出**可行动的**
 * 下一步（让用户去数据面板打开开关），并且**零出站**（未授权时一个字节都不发往服务端）。
 *
 * 三条不变量：
 *  - 即使被授权，AI 也**只看得到脱敏列**（`wasm_app_rows` 没有 `unmask` 参数）；
 *  - 授权是**按应用**的（看得到 A 不等于看得到 B）；
 *  - 拒绝里**不落**任何行内容（一个字节都没有，因为压根没有出站）。
 * @param locale - 宿主语言（按调用解析）。
 * @param appId - 应用标识。
 * @returns 错误信封（`status: 403`）。
 */
function aiRowsNotAuthorized(locale: HostLocale, appId: string): WasmResponse {
  return wasmError({
    code: AI_ROWS_NOT_AUTHORIZED,
    message: hostCopy(
      locale,
      `AI 还没有被授权读取应用 ${appId} 的数据（这是默认关的能力）`,
      `AI is not authorized to read the data of app ${appId} (this capability is off by default)`,
    ),
    status: 403,
    details: { app_id: appId, authorized: false },
    hints: [
      '这是**默认关**的：AI 读行数据必须由人在客户端里显式打开。请让用户打开「应用中心 → 该应用的详情 → 数据」面板，勾选「允许 AI 读取此应用的数据（仅脱敏列，每次调用写审计）」，然后重试本工具。',
      '不要改用 curl / 浏览器 / shell 去绕这条闸门：那条路要么没有员工令牌，要么被本机持有性证明挡住（且每次调用都会被平台审计）。',
      '即使被授权，本工具也**只**返回脱敏后的列（没有 unmask 参数）。要看原值必须由人在同一个面板里点「显示原值（会记审计）」。',
      '授权是**按应用**的：为 A 应用打开不代表为 B 应用打开。',
    ],
  })
}

/**
 * 把三个工具注册到 `ctx.tools`。
 *
 * 调用方**必须**从插件 fiber（`ctx.effect`）里调用并回收返回的 disposer：
 * 注册表的 disposer 不跟着 effect 走，漏回收会让插件重载后留下指向旧闭包的
 * 工具（本仓已有同款教训，见 browser 的 `applyBrowserTools` 注释）。
 * @param ctx - Host 上下文（用到 `picoSession` / `tools` / `logger`）。
 * @param options - 宿主依赖（语言解析器）。
 * @returns 注销全部工具的 disposer。
 */
export function registerWasmAppTools(ctx: Context, options: WasmAppToolOptions): () => void {
  const tools = ctx.tools as typeof ctx.tools | undefined
  if (tools === undefined || typeof tools.register !== 'function') {
    // 生产组合里由 `inject: ['tools']` 保证这个服务在场；只有最小组合（单测、
    // 无头嵌入）会缺席。此时**明确报错**而不是静默什么都不做 —— 静默会让
    // "工具没注册"表现成"模型说它没有这个工具"，而日志里一条线索都没有。
    ctx.logger?.error?.(
      `pico: tools service is absent — ${WASM_APP_TOOL_NAMES.join('/')} were NOT registered`,
    )
    return () => {}
  }
  const disposers: Array<() => void> = []

  /**
   * 前置闸门：会话必须存在；写面还必须不是审计账号。
   *
   * 与本地路由的 `writeGuard()` **同口径**（`role === 'auditor'` 拒绝写面），
   * 只是把结果做成信封而不是 HTTP 403 —— 模型看到的诊断信息一样多，而且与
   * 服务端业务错误的读法一致。
   */
  const gate = (
    locale: HostLocale,
    kind: 'read' | 'write',
  ): { ok: true, session: Session } | { ok: false, response: WasmResponse } => {
    const session = ctx.picoSession.getSession()
    if (session === null) {
      return {
        ok: false,
        response: wasmError({
          code: 'AUTH_REQUIRED',
          message: hostCopy(locale, '未登录：宿主机上没有员工会话', 'not logged in: this host has no employee session'),
          status: 401,
          hints: [
            '请让用户先在客户端登录，然后重试本工具：服务端要求员工令牌，AI 自己拿不到也不该持有它',
            '不要改用 curl 或其它途径直连服务端/本机写面：那条路要么没有令牌、要么被浏览器持有性证明挡住',
          ],
        }),
      }
    }
    if (kind === 'write' && session.role === 'auditor') {
      return {
        ok: false,
        response: wasmError({
          code: 'FORBIDDEN',
          message: hostCopy(locale, '审计账号不能修改应用', 'audit accounts cannot modify apps'),
          status: 403,
          hints: ['审计账号是只读的：请让应用发布者本人（或有写权限的员工）登录后再执行发布 / 预检'],
        }),
      }
    }
    return { ok: true, session }
  }

  /**
   * 统一的输出投影（成功给 body，失败给**原样**信封；渲染交给模型读 JSON）。
   *
   * 返回类型是无损 JSON：工具的输出契约就是它（`output.schema = {type:'json'}`），
   * 而信封里的 details 也已经是无损 JSON —— 两边同源，不需要任何断言。
   *
   * `skillHint` 只在失败且**值得指路**时非空（见 {@link skillHintAppliesTo}）：
   * 附在 hints 的**末尾**（服务端自己的 hints 是主证据，指路是补充，不能挤掉它）。
   */
  const asToolResult = (response: WasmResponse, skillHint: string | null = null): JsonValue => {
    const parsed = parseWasmBody(response)
    if (response.status >= 400) {
      // 先解析信封再判指路：`code` 决定这次失败是不是"作者写的东西不对"
      // （见 {@link skillHintAppliesTo} —— 网关/本地前置闸门不附指路）。
      const envelope = errorEnvelopeOf(response)
      const hint = skillHint !== null && skillHintAppliesTo(response.status, envelope?.code) ? skillHint : null
      if (envelope !== null) {
        if (hint !== null) envelope.hints = [...(envelope.hints ?? []), hint]
        return { ok: false, status: response.status, error: envelope }
      }
      // 认不出业务信封（网关 HTML / 代理劫持 / 空 body）：把原文带出去，
      // 绝不伪造一个 code —— 模型宁可见到真实字节，也不要一个编出来的错误码。
      // **也不附技能指路**：上游都没在说我们的协议，装作者手册与此无关
      // （独立验证 2026-09-18 R-1；`skillHintAppliesTo` 无 code 时同样返回 false）。
      return {
        ok: false,
        status: response.status,
        error: {
          code: 'UNEXPECTED_UPSTREAM_BODY',
          message: hostCopy(options.locale(), '上游返回的不是业务信封', 'the upstream response is not a business error envelope'),
        },
        body: parsed ?? response.text,
      }
    }
    return { ok: true, status: response.status, body: parsed ?? response.text }
  }

  /**
   * 写面工具的统一收尾：失败时按需附上「先装作者手册」的指路。
   *
   * 作者手册（{@link APP_BUILDER_SKILL}）是 `wasm_app_*` 失败后模型唯一能自证的资料：
   * 没有它，模型只能靠猜 API 形态，会把"导入面不对""字段名写错"误诊成工具坏了。
   * 用户明确要求过这条指路必须由工具面给出（`builtin-skills.ts` 的头注释）。
   *
   * 成功路径**不做任何 stat**（每次发布都白查一次磁盘没有必要）。
   */
  const asWriteToolResult = async (response: WasmResponse): Promise<JsonValue> =>
    asToolResult(response, response.status >= 400 ? await resolveSkillHint(options.locale()) : null)

  const output = {
    schema: { type: 'json' as const },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  }

  // ---------------------------------------------------------------- list

  disposers.push(tools.register(defineTool({
    name: 'wasm_app_list',
    description: [
      '列出应用中心里的 WASM 应用（应用标识、标题、负责人、访问模式 access、是否上架 enabled、当前版本、入口链接）。',
      '发布前用它确认两件事：app_id 有没有被占用、以及已有应用的**当前版本号**（新版本号必须严格大于它）。',
      // ⚠️ 这句曾经写成"下架的域名仍然可访问，只是不在应用中心推荐"，**两个分句都与实现相反**
      // （独立评审 R1-pm-5 / R1-uxc-1）：
      //   - 访问：`enabled=false` ⇒ 应用子域 **410 Gone**（server/internal/wasmapp/appserver/serve.go:80-85
      //     的 writeGone，文案见 respond.go:149-155："应用已下架…数据仍然保留"）；
      //   - 目录：下架条目**照样列在应用中心**（api/read.go:432-441 的目录条件，
      //     服务端同一处注释已就地勘误）。
      '**已下架**（enabled=false）的应用也会列出，但它的域名**不能访问**：应用子域对下架应用一律返回 410 Gone（数据保留、恢复上架后链接不变），不要据此认为标识空闲。',
      '只读，不改变任何状态。',
    ].join(''),
    parameters: {},
    output,
    timeoutMs: WASM_APP_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const locale = options.locale()
      const allowed = gate(locale, 'read')
      if (!allowed.ok) return asToolResult(allowed.response)
      return asToolResult(await listCatalog(ctx, allowed.session, exec.signal))
    },
  })))

  // ------------------------------------------------------------ validate

  disposers.push(tools.register(defineTool({
    name: 'wasm_app_validate',
    description: [
      '发布前预检一个 WASM 应用产物：服务端做静态校验（导入面 / 导出 / 段表 / 体积）+ 真编译 + 合成帧干跑，',
      '返回体积、校验和、导入导出清单与是否首版。**不占版本号、不进审计、不改线上版本**，失败也不消耗版本号，可以反复调用。',
      '正确的用法是：先 validate 把错误改完，再 publish。',
      RATE_LIMIT_DESCRIPTION,
      SKILL_POINTER,
    ].join(''),
    parameters: {
      appId: { type: 'string', required: true, description: APP_ID_DESCRIPTION },
      wasmPath: { type: 'string', required: true, description: WASM_PATH_DESCRIPTION },
      version: { type: 'string', description: `可选：这次打算发布的版本号，带上它会一起做形态预检。${VERSION_DESCRIPTION}` },
      title: { type: 'string', description: `可选：打算使用的标题，带上它会一起做首版必填预检。${TITLE_DESCRIPTION}` },
      config: {
        type: 'object',
        additionalProperties: false,
        description: APP_CONFIG_DESCRIPTION_OPTIONAL,
        properties: APP_CONFIG_PROPERTIES,
      },
    },
    output,
    timeoutMs: WASM_APP_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const locale = options.locale()
      const allowed = gate(locale, 'write')
      if (!allowed.ok) return asToolResult(allowed.response)
      return asWriteToolResult(await validateApp(ctx, allowed.session, {
        appId: args.appId.trim(),
        wasm: { kind: 'path', value: args.wasmPath.trim() },
        locale,
        signal: exec.signal,
        ...(args.version === undefined ? {} : { version: args.version.trim() }),
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.config === undefined ? {} : { config: args.config }),
      }))
    },
  })))

  // ------------------------------------------------------------- publish

  disposers.push(tools.register(defineTool({
    name: 'wasm_app_publish',
    description: [
      '把本机编译好的 .wasm 产物发布为应用的一个新版本。服务端**同步**执行：静态校验 → 真编译（最长约 60 秒）→ 干跑 → 落库 → 切换线上版本；',
      '宿主侧单次出站预算 90 秒，大于 8 MiB 的产物自动分片续传（断线后重发只会补缺失的分片，可从 UPLOAD_INCOMPLETE 的 details.upload_id 续传）。',
      '发布者身份 = **当前登录员工**（服务端按会话令牌记录归属：谁让 AI 发的就记谁，不能替他人发布）。',
      'config **必填**（首次发布时 purpose / data_sensitivity / owner 三个声明缺一不可；更新版本时未改动的可以省略，服务端沿用原值）；',
      '给已有应用发新版本必须写 changelog（首版可以省略）。',
      '失败不占版本号：按返回的 error.code / details / hints 改完，用同一个版本号重发即可。',
      // 待审语义分两种（原句只写了第一种，"首版"那半句与实现不符）：
      // 已有应用：目录与子域都继续用生效版本（serve.go 取 LatestApproved）；
      // **首版**：没有任何 approved 版本 ⇒ 目录直接不列（api/read.go:440 的
      // `CurrentReleaseID <= 0 → continue`）、子域 404"应用还没有可用版本"
      // （appserver/serve.go:96-103）。写"线上仍是旧版本"会让模型以为首版也在服务。
      '若企业开启了更新审批，新版本会进待审队列（结果里 status=pending）：已有应用线上仍是旧版本、不影响正在使用的用户；',
      '**首版**发布时则是"审核通过前应用还没有可用版本"（应用中心里也还看不到它）。',
      SKILL_POINTER,
    ].join(''),
    parameters: {
      appId: { type: 'string', required: true, description: APP_ID_DESCRIPTION },
      version: { type: 'string', required: true, description: VERSION_DESCRIPTION },
      wasmPath: { type: 'string', required: true, description: WASM_PATH_DESCRIPTION },
      title: { type: 'string', required: true, description: TITLE_DESCRIPTION },
      changelog: { type: 'string', description: CHANGELOG_DESCRIPTION },
      config: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: APP_CONFIG_DESCRIPTION,
        properties: APP_CONFIG_PROPERTIES,
      },
      uploadId: { type: 'string', description: UPLOAD_ID_DESCRIPTION },
    },
    output,
    timeoutMs: WASM_APP_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const locale = options.locale()
      const allowed = gate(locale, 'write')
      if (!allowed.ok) return asToolResult(allowed.response)
      return asWriteToolResult(await publishApp(ctx, allowed.session, {
        appId: args.appId.trim(),
        version: args.version.trim(),
        wasm: { kind: 'path', value: args.wasmPath.trim() },
        locale,
        signal: exec.signal,
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.changelog === undefined ? {} : { changelog: args.changelog }),
        ...(args.config === undefined ? {} : { config: args.config }),
        ...(args.uploadId === undefined ? {} : { uploadId: args.uploadId.trim() }),
      }))
    },
  })))

  // ------------------------------------------------- schema / diagnostics / rows
  //
  // 回读面（2026-09-21）：这一步之前，工具面只有"写"（list/validate/publish），
  // 而技能文档要求模型"先读诊断，再改代码" —— 那条链路上根本没有工具。
  //
  // 三条工具的能力边界（与产品口径一致，见 server/internal/wasmapp/api/rows.go）：
  //   - schema / diagnostics：**零隐私**（结构、失败码、hints），默认可读；
  //   - rows：只读一页行，且**永远请求服务端的默认脱敏**（本文件不透传 unmask）
  //     —— 原值只能由人在客户端面板里显式点「显示原值（会记审计）」。
  //
  // **为什么 rows 是"注册但拒绝"而不是"未授权就不注册"**（2026-09-21 用户拍板后定：
  // 默认关 + 显式授权卡）：
  //   - 授权是**按应用**且**运行期可变**的（人在面板上随时开/关）。按状态动态增删工具
  //     会让"模型可见的工具清单"随外部状态漂移：同一段对话里前一句有、后一句没有，
  //     而模型无法解释、只能重试；
  //   - 拒绝是一个**可行动的答案**（稳定 code + "让用户去数据面板打开"的指路），
  //     而"清单里没有这个工具"只会让模型以为平台不支持读数据 —— 它连"该请人授权"
  //     都想不到，转而用 curl/浏览器硬闯（那两条路分别没有令牌、被持有性证明挡住）。
  //   - 代价（如实认账）：清单里**常驻**一个当前不可用的工具。这个代价落在描述里 ——
  //     description 第一句就写清"这是默认关的能力、拿到 AI_ROWS_NOT_AUTHORIZED 该做什么"。

  disposers.push(tools.register(defineTool({
    name: 'wasm_app_schema',
    description: [
      '读取一个应用的**表结构**（表名、列名/类型、行数、库体积与上限）。只读。',
      '排障用法：数据对不上时先跑它，确认表与列**真的像你以为的那样**（db.define 没生效、列名拼错、表名大小写不符都在这里现形），再用 wasm_app_rows 看几行数据。',
      '仅发布者本人可读（他人与"应用不存在"同形 404）；每次调用都会被平台审计。',
    ].join(''),
    parameters: {
      appId: { type: 'string', required: true, description: APP_ID_DESCRIPTION },
    },
    output,
    timeoutMs: WASM_APP_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const locale = options.locale()
      const allowed = gate(locale, 'read')
      if (!allowed.ok) return asToolResult(allowed.response)
      return asToolResult(await readAppSchema(ctx, allowed.session, args.appId.trim(), exec.signal))
    },
  })))

  disposers.push(tools.register(defineTool({
    name: 'wasm_app_diagnostics',
    description: [
      '读取一个应用的**运行诊断**（时间窗口内的调用总数、失败/被杀次数、按次数排序的 reason_code 与可操作 hints、单条失败记录含 guest 退出码与 stderr 尾巴）。只读。',
      '这是技能文档里"先读诊断，再改代码"的那个入口：`reasons[0]` 的 hints 就是下一步该改什么，不要靠猜。',
      '`outcome` 是 `error` 或 `killed` 都算失败；响应结构是 `{"diagnostics":{summary:{...},failures:[...],hints:[...]}}`。',
    ].join(''),
    parameters: {
      appId: { type: 'string', required: true, description: APP_ID_DESCRIPTION },
      minutes: { type: 'integer', description: '诊断窗口（分钟；缺省 24 小时，上限 = 调用事件保留期）' },
    },
    output,
    timeoutMs: WASM_APP_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const locale = options.locale()
      const allowed = gate(locale, 'read')
      if (!allowed.ok) return asToolResult(allowed.response)
      return asToolResult(await readAppDiagnostics(ctx, allowed.session, args.appId.trim(), args.minutes, exec.signal))
    },
  })))

  disposers.push(tools.register(defineTool({
    name: 'wasm_app_rows',
    description: [
      '读取一个应用某张表的一页数据（只读；缺省 50 行、最多 200 行；用 offset 翻页）。',
      '**这是默认关的能力**：必须先由人在客户端「应用中心 → 该应用详情 → 数据」面板里打开「允许 AI 读取此应用的数据」，',
      '否则本工具会返回 `AI_ROWS_NOT_AUTHORIZED`（**不会**发出任何请求，也**不会**回一个空表让你误以为数据没写进去）。',
      '拿到该错误时请把面板路径告诉用户并请其打开开关，然后重试；不要改用 curl/浏览器去绕（那条路没有令牌）。',
      '**敏感列默认脱敏**（服务端按列名判定，值显示为 ***）：本工具**不能**解掉这层保护 —— 要看原值只能由人在同一个面板里点「显示原值」（那一次会单独记审计）。',
      '用法：先用 wasm_app_schema 拿到表名与列名（表名规则：小写字母开头、只含 [a-z0-9_]），再用本工具确认"数据是不是真的写进去了"。',
      '返回 `total_rows` / `has_more` / `truncated_values`：分页与截断都以服务端返回的这两个字段为准，不要按返回条数猜。',
      '每次调用都会被平台审计（动作 `wasm_app_rows_view`），审计只记表名与分页，不记行内容。',
    ].join(''),
    parameters: {
      appId: { type: 'string', required: true, description: APP_ID_DESCRIPTION },
      table: { type: 'string', required: true, description: '表名（db.define 用的那个；先用 wasm_app_schema 查）' },
      limit: { type: 'integer', description: '本页行数（缺省 50，上限 200；越界会被服务端收敛）' },
      offset: { type: 'integer', description: '跳过的行数（缺省 0；翻页用）' },
    },
    output,
    timeoutMs: WASM_APP_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const locale = options.locale()
      const allowed = gate(locale, 'read')
      if (!allowed.ok) return asToolResult(allowed.response)
      const appId = args.appId.trim()
      // **默认关的闸门**（2026-09-21 用户拍板）：未授权 ⇒ 结构化拒绝且**零出站**。
      // 判据顺序是契约的一部分：先查本机授权，再碰任何出站 —— 顺序反过来就会出现
      // "人还没授权，但服务端已经收到一次调用（并写了一条审计）"。
      const consent = options.aiRowsConsent ?? DENY_ALL_AI_ROWS
      if (!await consent.isEnabled(appId)) return asToolResult(aiRowsNotAuthorized(locale, appId))
      return asToolResult(await readAppRows(ctx, allowed.session, appId, {
        table: args.table.trim(),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.offset === undefined ? {} : { offset: args.offset }),
      }, exec.signal))
    },
  })))

  return () => { for (const dispose of disposers) dispose() }
}

/**
 * 工具预算与出站预算的序关系（唯一不变量，测试与调用方都读它）。
 *
 * 存在意义：两个数字分别定义在两个模块里，谁把它们改成"工具先到点"就会让所有
 * 诊断信息被上游超时策略吞掉，而那种故障在测试里表现为"偶发超时"，极难定位。
 * @returns 工具预算 − 出站预算（毫秒，必须为正）。
 */
export function wasmAppToolHeadroomMs(): number {
  return WASM_APP_TOOL_TIMEOUT_MS - CLIENT_UPLOAD_TIMEOUT_MS
}
