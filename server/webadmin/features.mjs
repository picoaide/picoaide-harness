/**
 * webadmin **变体（功能模块开关）的构建期唯一真源**：`FEATURES=<变体标识>` → define 表。
 *
 * 契约见 `docs/decisions/2026-10-13-channel-feature-modules.md` §5（P0：模块名与变体标识）
 * 与 `docs/decisions/2026-10-14-webadmin-feature-variant.md`（本片：webadmin 侧消费）。
 *
 * ## 为什么是一个 `.mjs` 而不是写在 `vite.config.ts` 里
 *
 * 变体必须由**同一个串**派生，而读它的有两个 vite 实例（构建链 `vite.config.ts`、
 * 测试链 `vitest.config.ts`）以及产物判据 `scripts/check-feature-chunks.mjs`。
 * 三处各写一遍解析就是三套口径 —— 其中一套把 `none` 当成"没设置"时，
 * 构建会静默产出全开的产物而没有任何红灯。所以解析只有这一份实现，三处都 import 它。
 *
 * ## 编码（**与 Go 侧 `-tags` 是同一个串的两种编码**）
 *
 * | `FEATURES=` | 开启模块 | Go 侧 |
 * | --- | --- | --- |
 * | （未设置） | 三个全开（**缺省，既有行为不变**） | `GO_TAGS ?= skills,apps,connectors` |
 * | `skills,apps,connectors` | 三个全开 | `-tags=skills,apps,connectors` |
 * | `apps,connectors` | 关 skills | `-tags=apps,connectors` |
 * | `none` | 三个全关 | `-tags=`（空集） |
 * | `''`（空串） | **报错**（不是"全关"） | `-tags=`（空集 = 全关） |
 *
 * 空串刻意 fail-loud：P0 §5 的硬约束是"`none` 是**显式**取值，不用空串（空串在 shell/CI 里
 * 到处都是'没设置'的歧义）"。把空串当"全关"会让 `--build-arg FEATURES=` 这种手滑静默产出
 * 一个空管理端；当成"全开"则与 Go 侧同一行参数的含义相反。两种猜法都会造出
 * "服务端裁了、管理端没裁"（或反过来）的半通状态，所以这里要求写清楚。
 *
 * @module picoaide-webadmin/features
 */

/** 模块清单 —— **顺序是契约的一部分**（与 Go `internal/features`、渠道 `FEATURE_MODULES` 逐字一致）。 */
// @generated:module-contract (scripts/gen-module-contract.mjs) — 手改会被 --check 判红
export const FEATURE_MODULES = ['skills', 'apps', 'connectors']
// @end:module-contract

/** 缺省变体标识 = 三个模块全开（不设 `FEATURES` 时的行为，与改造前逐字节同源）。 */
export const DEFAULT_FEATURES_VARIANT = FEATURE_MODULES.join(',')

/** 三个模块全关的**显式**取值（不是空串）。 */
export const NONE_FEATURES_VARIANT = 'none'

/** 变体标识的环境变量名（与 P0 §5 的消费键名 `FEATURES` 逐字一致）。 */
export const FEATURES_ENV_KEY = 'FEATURES'

/**
 * 一个模块名（{@link FEATURE_MODULES} 的成员）。
 * @typedef {'skills' | 'apps' | 'connectors'} FeatureModule
 */

/**
 * 模块名 → 构建期注入的全局开关标识符。
 *
 * 每模块一个**布尔字面量**（而不是"变体串 + `.includes()`"）：打包器的分支折叠只认字面量。
 * 实测（vite 5 / rollup 4，见决策记录 §2 的探针）：`__FEATURE_X__ ? () => import(…) : null`
 * 在 `__FEATURE_X__ = false` 时真的不产出该 chunk，而 `__FEATURES__.includes('x')` **不会**
 * 被折叠（chunk 照样进 dist）—— 判据 `scripts/check-feature-chunks.mjs` 对后者会红。
 * @param {FeatureModule} module - 模块名。
 * @returns {string} 形如 `__FEATURE_SKILLS__`。
 */
export function featureGlobalName(module) {
  return `__FEATURE_${module.toUpperCase()}__`
}

/** 变体标识本身也注入（运行期要报告/落 DOM 属性时用它；消费方**不得**自己拼这个串）。 */
export const FEATURES_VARIANT_GLOBAL = '__FEATURES__'

/**
 * 解析变体标识（**唯一一份解析实现**）。
 *
 * 规则：逗号分隔的模块名，顺序无关但输出按 {@link FEATURE_MODULES} 归一；重复项报错
 * （`skills,skills` 是手滑，不是"更强调"）；未知名字**必须**报错 —— 静默忽略一个拼错的名字
 * 等于把"关掉 connectors"变成"全都开着"。
 * @param {string | undefined} raw - `FEATURES` 的取值（`undefined` = 未设置）。
 * @returns {{ variant: string, enabled: Record<FeatureModule, boolean> }} 归一后的变体标识 + 逐模块布尔。
 * @throws {Error} 取值非法（未知模块 / 重复 / 空串 / 非字符串）时抛出，消息里附可执行指引。
 */
export function resolveFeatures(raw) {
  if (raw === undefined) {
    return { variant: DEFAULT_FEATURES_VARIANT, enabled: enabledFrom(FEATURE_MODULES) }
  }
  if (typeof raw !== 'string') {
    throw new Error(`${FEATURES_ENV_KEY} 必须是字符串，收到 ${typeof raw}`)
  }
  if (raw.trim() === '') {
    throw new Error(
      `${FEATURES_ENV_KEY} 是空串：本变量**不把空串当"全关"**（那是 Go 侧 -tags= 的编码）。`
        + `三个模块全关请显式写 ${FEATURES_ENV_KEY}=${NONE_FEATURES_VARIANT}；不设置=全开。`,
    )
  }
  const tokens = raw.split(',').map((token) => token.trim())
  const empty = tokens.indexOf('')
  if (empty >= 0) {
    throw new Error(
      `${FEATURES_ENV_KEY}=${JSON.stringify(raw)} 里有空项（逗号分隔、不加空格）：`
        + `合法取值是 ${FEATURE_MODULES.join(' / ')} 的子集，或 ${NONE_FEATURES_VARIANT}`,
    )
  }
  // `none` 先判：它是**显式**取值（不是模块名），不能混进模块名的未知判定里。
  if (tokens.length === 1 && tokens[0] === NONE_FEATURES_VARIANT) {
    return { variant: NONE_FEATURES_VARIANT, enabled: enabledFrom([]) }
  }
  if (tokens.includes(NONE_FEATURES_VARIANT)) {
    throw new Error(
      `${FEATURES_ENV_KEY}=${JSON.stringify(raw)} 把 ${NONE_FEATURES_VARIANT} 与模块名混写了：`
        + `${NONE_FEATURES_VARIANT} 是"三个全关"的**整体**取值，单独写；只关一部分请写其余模块名`
        + `（例：${FEATURE_MODULES[0]},${FEATURE_MODULES[1]}）`,
    )
  }
  const unknown = tokens.filter((token) => !FEATURE_MODULES.includes(token))
  if (unknown.length > 0) {
    throw new Error(
      `${FEATURES_ENV_KEY}=${JSON.stringify(raw)} 含未知模块名 ${unknown.join(', ')}：`
        + `合法模块名 ${FEATURE_MODULES.join(' / ')}（与 Go 侧 -tags、渠道配置 features 逐字一致）`,
    )
  }
  const duplicated = tokens.filter((token, index) => tokens.indexOf(token) !== index)
  if (duplicated.length > 0) {
    throw new Error(`${FEATURES_ENV_KEY}=${JSON.stringify(raw)} 里 ${duplicated.join(', ')} 重复出现`)
  }
  // 归一顺序：`apps,skills` 与 `skills,apps` 必须得到同一个变体标识（它同时是缓存键）。
  const on = FEATURE_MODULES.filter((module) => tokens.includes(module))
  return { variant: on.join(','), enabled: enabledFrom(on) }
}

/**
 * 开启模块清单 → 逐模块布尔表（三个键**全在**，下游不必再实现一次"缺省全开"）。
 * @param {readonly string[]} on - 开启的模块名。
 * @returns {Record<FeatureModule, boolean>} 逐模块布尔。
 */
function enabledFrom(on) {
  /** @type {Record<string, boolean>} */
  const enabled = {}
  for (const module of FEATURE_MODULES) enabled[module] = on.includes(module)
  return /** @type {Record<FeatureModule, boolean>} */ (enabled)
}

/**
 * 解析结果 → vite `define` 表。
 *
 * **每模块一个布尔字面量**（`'true'` / `'false'` 而不是表达式）是实现细节里的承重部分：
 * 打包器只折叠字面量条件，写成 `__FEATURES__.includes(…)` 时被关闭模块的页面 chunk
 * **照样进 dist**（实测，见 {@link featureGlobalName}）。
 * @param {{ variant: string, enabled: Record<FeatureModule, boolean> }} features - {@link resolveFeatures} 的结果。
 * @returns {Record<string, string>} `define` 表。
 */
export function featureDefines(features) {
  /** @type {Record<string, string>} */
  const defines = { [FEATURES_VARIANT_GLOBAL]: JSON.stringify(features.variant) }
  for (const module of FEATURE_MODULES) {
    defines[featureGlobalName(module)] = features.enabled[module] === true ? 'true' : 'false'
  }
  return defines
}

/**
 * 从环境变量读并解析变体（构建入口用这一条）。
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] - 环境（缺省 `process.env`）。
 * @returns {{ variant: string, enabled: Record<FeatureModule, boolean> }} 解析结果。
 */
export function resolveFeaturesFromEnv(env = process.env) {
  return resolveFeatures(env?.[FEATURES_ENV_KEY])
}
